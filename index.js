import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import fsSync, { promises as fs } from 'fs';
import { existsSync } from 'fs';
// import HttpsProxyAgent from 'https-proxy-agent';

// Workflow is run every 40 minutes

const item_info_link = "https://raw.githubusercontent.com/Kastuks/market-information/refs/heads/main/data/cs2_items.json";
const skins_to_name_id = "https://raw.githubusercontent.com/somespecialone/steam-item-name-ids/refs/heads/master/data/cs2.json";
const runWorkflowFor = 100; // seconds
const BASE_URL = 'https://steamcommunity.com/market';
const GAME_ID = 730;
const DELAY_MS = 7000;
const DELAY_AFTER_TIMEOUT = 30000;
const MAX_RETRIES = 5;
const outputPath = 'data/cs2_items.json';
const maxItemsProcessed = Math.trunc(runWorkflowFor / (DELAY_MS / 1000));
let usdToEurConversion = 0.9;

async function fetchAdditionalItemInfo() {
  return new Promise(async (resolve, reject) => {
      const url = item_info_link;
      const options = {
        headers: {
          'Authorization': 'token ' + process.env.BOT_GITHUB_TOKEN
        }
      }
      await axios.get(url, options).then((response) => {
        const data = response.data;
        resolve(data);
      });
  });
}

async function fetchSkinsToNameIds() {
  return new Promise(async (resolve, reject) => {
      const url = skins_to_name_id;
      await axios.get(url).then((response) => {
        const data = response.data;
        resolve(data);
      });
  });
}

function getUsdToEurConversionRate() {
  const options = {
	"method": "GET",
	"url": "https://api.fxratesapi.com/latest"
  };

  axios.request(options).then(function (response) {
    usdToEurConversion = response.data.rates.EUR;
  }).catch(function (error) {
    console.error(error);
  });
}

// Optional: List of proxies
const PROXIES = [
  // 'http://username:password@proxyhost:port',
  // 'http://proxyhost:port',
];

let proxyIndex = 0;
function getAxiosInstance() {
  if (PROXIES.length === 0) return axios;
  const proxy = PROXIES[proxyIndex++ % PROXIES.length];
  // const agent = new HttpsProxyAgent(proxy);
  // return create({ httpsAgent: agent });
  return axios;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function retry(fn, retries = MAX_RETRIES) {
  let attempt = 0;
  let delay = DELAY_AFTER_TIMEOUT;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      console.warn(`Retry ${attempt}/${retries}: ${err.message}`);
      await sleep(delay);
      delay *= 2; // Exponential backoff
    }
  }
  throw new Error('Max retries reached.');
}

async function fetchAllItemNames(savePath = outputPath) {
  let items = [];
  let itemsMap = {};
  let start = 0;
  const count = 1;
  let maxAmount = Infinity;

  const itemListFromRender = await fetchAdditionalItemInfo();
  const hashNameToNameId = await fetchSkinsToNameIds();

   // Resume if file exists
  if (fsSync.existsSync(savePath)) {
    try {
      const existing = JSON.parse(await fs.readFile(savePath, 'utf8'));
      items = existing;
      itemsMap = Object.fromEntries(existing.map(item => [item.hash_name, item]));
      start = await loadStartFrom();
      console.log(`Resuming from item #${start}`);
    } catch {
      items = [];
    }
  }

  if ((start + maxItemsProcessed) > itemListFromRender.length) {
    maxAmount = itemListFromRender.length;
  } else {
    maxAmount = start + maxItemsProcessed;
  }

  while (start < maxAmount) {
    try {
      const currentItem = itemListFromRender[start];
      const currentItemName = currentItem.hash_name;
      const itemNameId = hashNameToNameId[currentItemName];
      console.log(`Processing item: ${currentItemName} (ID: ${itemNameId})`);

      const url = `${BASE_URL}/itemordershistogram?norender=1&country=NL&language=english&currency=3&item_nameid=${itemNameId}&two_factor=0`;
      const axiosInstance = getAxiosInstance();
      const { data } = await retry(() => axiosInstance.get(url));
    
      if (itemsMap[currentItemName]) {
        itemsMap[currentItemName] = {
          ...itemsMap[currentItemName],
          sell_order_count: data.sell_order_count,
          buy_order_count: data.buy_order_count,
          lowest_sell_order: convertCentsToEur(data.lowest_sell_order),
          highest_buy_order: convertCentsToEur(data.highest_buy_order),
          date_modified: Date.now(),
        }
      } else {
        itemsMap[currentItemName] = {
          hash_name: currentItemName,
          item_nameid: itemNameId,
          image: currentItem.image,
          sell_order_count: data.sell_order_count,
          buy_order_count: data.buy_order_count,
          lowest_sell_order: convertCentsToEur(data.lowest_sell_order),
          highest_buy_order: convertCentsToEur(data.highest_buy_order),
          date_modified: Date.now(),
        };
      }

      console.log(`Fetched ${currentItemName} ${start}/${maxAmount}`);
    
      await fs.writeFile(savePath, JSON.stringify(Object.values(itemsMap), null, 2));
    
      start += count;
      if (start <= maxAmount) {
        await setStartFrom(start);
      } 
      if (itemListFromRender.length > 1 && start >= itemListFromRender.length) {
        await setStartFrom(0);
        console.log(`Reached end of item list at index ${start}. Setting start_from to 0.`);
      }
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`Error fetching items at start=${start}: ${err.message}`);
      await sleep(30000);
    }
  }
  
  return items;
}

async function fetchPriceInfo(itemName) {
  const encodedName = encodeURIComponent(itemName);
  const url = `${BASE_URL}/priceoverview/?currency=1&appid=${GAME_ID}&market_hash_name=${encodedName}`;
  const axiosInstance = getAxiosInstance();
  const { data } = await retry(() => axiosInstance.get(url));
  return {
    lowest_price: data.lowest_price || null,
    buy_order_price: data.lowest_buy_order || null,
  };
}

async function loadExistingItems(path) {
  if (!existsSync(path)) return {};
  try {
    const data = await fs.readFile(path, 'utf-8');
    const items = JSON.parse(data);
    return Object.fromEntries(items.map(item => [item.hash_name, item]));
  } catch {
    return {};
  }
}

async function loadStartFrom() {
  const path = 'data/start_from.json';
  if (!existsSync(path)) return {};
  try {
    const data = await fs.readFile(path, 'utf-8');
    const startFrom = JSON.parse(data);
    if (!startFrom || startFrom.start_from < 0) {
      console.warn(`Invalid start_from value ${startFrom}, resetting to 0`);
      await setStartFrom(0);
      return 0;
    }
    return startFrom.start_from;
  } catch {
    console.error(`Failed to get start_from, starting from 0`);
    await setStartFrom(0);
    return 0;
  }
}

async function setStartFrom(startFrom) {
  const path = 'data/start_from.json';
  const startFromToSave = { start_from: startFrom };
  if (!existsSync(path)) return {};
  try {
    await fs.writeFile(path, JSON.stringify(startFromToSave, null, 2));
  } catch {
    console.error(`Failed to save start_from to ${path}`);
  }
}

function convertUSDToEur(usdPrice) {
  return ((usdPrice.replace('$', '').replace(',', '') * usdToEurConversion).toFixed(2)).toString().concat('€')
}

function convertCentsToEur(centsPrice) {
  return ((centsPrice / 100).toFixed(2)).toString();
}


async function main() {
  getUsdToEurConversionRate();
  // const itemListFromRender = await fetchAdditionalItemInfo();
  // console.log(`Fetched ${itemListFromRender.length} items from render.`);
  // const existing = await loadExistingItems(outputPath);
  const items = await fetchAllItemNames();

  // const updated = { ...existing };

  // for (let i = 0; i < items.length; i++) {
  //   const item = items[i];
  //   if (updated[item.hash_name]) {
      // console.log(`[${i + 1}/${items.length}] Skipping already fetched: ${item.hash_name}`);
    //   continue;
    // }

    // try {
      // const prices = await fetchPriceInfo(item.hash_name);
      // updated[item.hash_name] = {
      //   hash_name: item.hash_name,
      //   image: item.image,
      //   lowest_price: prices.lowest_price,
      //   buy_order_price: prices.buy_order_price,
      // };
      // console.log(`[${i + 1}/${items.length}] ${item.hash_name} - ${prices.lowest_price || 'N/A'}`);
      // await fs.writeFile(outputPath, JSON.stringify(Object.values(updated), null, 2));
      // await sleep(DELAY_MS);
  //   } catch (err) {
  //     console.error(`Failed to fetch price for ${item.hash_name}: ${err.message}`);
  //   }
  // }

  console.log(`Done! Saved ${items.length} items to ${outputPath}`);
}

main();
