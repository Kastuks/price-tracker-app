import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import fsSync, { promises as fs } from 'fs';
import { existsSync } from 'fs';
// import HttpsProxyAgent from 'https-proxy-agent';

const item_info_link = "https://raw.githubusercontent.com/Kastuks/market-information/refs/heads/main/data/cs2_items.json";
const skins_to_name_id = "https://raw.githubusercontent.com/somespecialone/steam-item-name-ids/refs/heads/master/data/cs2.json";
const runWorkflowFor = 2400; // seconds
const BASE_URL = 'https://steamcommunity.com/market';
const local_skins_to_name_id_path = "backup/cs2_skins_to_name_id.json";
const GAME_ID = 730;
const DELAY_MS = 8000;
const DELAY_AFTER_TIMEOUT = 30000;
const MAX_RETRIES = 5;
const outputPath = 'data/cs2_items.json';
const maxItemsProcessed = Math.trunc(runWorkflowFor / (DELAY_MS / 1000));
const batchNum = process.env.BATCH_NUM || 1;
const batchSize = 8;
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

async function fetchSkinsToNameIds(fetchLocal = false) {
  return new Promise(async (resolve, reject) => {
      if (fetchLocal && existsSync(local_skins_to_name_id_path)) {
        const data = JSON.parse(await fs.readFile(local_skins_to_name_id_path, 'utf8'));
        resolve(data);
      }
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

async function fetchAllItemPrices(savePath = batchNum ? `data/cs2_prices/cs2_items_${batchNum}.json` : outputPath) {
  const itemListFromRender = await fetchAdditionalItemInfo();
  const hashNameToNameId = await fetchSkinsToNameIds(true);

  let currentBatchStart = 0;
  let currentBatchMaximum = itemListFromRender.length;
  let items = [];
  let itemsMap = {};
  let start = 0;
  const count = 1;
  let maxAmount = Infinity;

  if (fsSync.existsSync(savePath)) {
    try {
      const existing = JSON.parse(await fs.readFile(savePath, 'utf8'));
      items = existing;
      itemsMap = Object.fromEntries(existing.map(item => [item.hash_name, item]));
      start = await loadStartFrom();
      currentBatchStart = start;
    } catch {
      items = [];
    }
  }

  if (batchNum) {
    const batchUnit = Math.trunc(itemListFromRender.length / batchSize)
    currentBatchStart += ((batchNum - 1) *  batchUnit);
    // env picks up a string instead of number, that's why we do != intead of !== here
    if (batchNum != batchSize) {
      currentBatchMaximum = batchNum * batchUnit;
    }
  }

  if (currentBatchStart >= currentBatchMaximum) {
    currentBatchStart -= start;
    start = 0;
    await setStartFrom(0);
  }

  if ((currentBatchStart + maxItemsProcessed) > currentBatchMaximum) {
    maxAmount = currentBatchMaximum;
  } else {
    maxAmount = currentBatchStart + maxItemsProcessed;
  }

  console.log(`Starting batch ${batchNum}, start: ${start} from index currentBatchStart: ${currentBatchStart} to maxAmount: ${maxAmount}, currentBatchMaximum: ${currentBatchMaximum}`);
  while (currentBatchStart < maxAmount) {
    try {
      const currentItem = itemListFromRender[currentBatchStart];
      const currentItemName = currentItem.hash_name;
      const itemNameId = hashNameToNameId[currentItemName];
      console.log(`Processing item: ${currentItemName} (ID: ${itemNameId})`);

      start += count;
      currentBatchStart += count;
      if (currentBatchStart <= maxAmount) {
        await setStartFrom(start);
      }

      if (itemListFromRender.length > 1 && currentBatchStart >= currentBatchMaximum) {
        await setStartFrom(0);
        console.log(`Reached end of item list at index ${start}. Setting start_from to 0.`);
      }

      if (itemNameId === undefined) {
        console.warn(`No name ID found for item: ${currentItemName}`);
        continue;
      }

      const url = `${BASE_URL}/itemordershistogram?norender=1&country=NL&language=english&currency=3&item_nameid=${itemNameId}&two_factor=0`;
      const axiosInstance = getAxiosInstance();
      const { data } = await retry(() => axiosInstance.get(url), 2);
    
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

      console.log(`Fetched ${currentItemName} ${currentBatchStart}/${maxAmount}`);
      await fs.writeFile(savePath, JSON.stringify(Object.values(itemsMap), null, 2));
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`Error fetching items at start=${start}: ${err.message}`);
      await sleep(30000);
    }
  }
  
  return itemsMap;
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

async function loadStartFrom() {
  const path = batchNum ? `data/start_from/start_from_${batchNum}.json` : 'data/start_from.json';
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
  const path = batchNum ? `data/start_from/start_from_${batchNum}.json` : 'data/start_from.json';
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
  const items = await fetchAllItemPrices();

  console.log(`Done! Saved ${items.length} items to ${outputPath}`);
}

main();