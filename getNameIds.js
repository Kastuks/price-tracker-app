import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import fsSync, { promises as fs } from 'fs';
import { existsSync } from 'fs';

const item_info_link = "https://raw.githubusercontent.com/Kastuks/market-information/refs/heads/main/data/cs2_items.json";
const local_skins_to_name_id_path = "backup/cs2_skins_to_name_id.json";
const runWorkflowFor = 1200; // seconds
const BASE_URL = 'https://steamcommunity.com/market';
const DELAY_MS = 10000;
const DELAY_AFTER_TIMEOUT = 30000;
const MAX_RETRIES = 5;
const maxItemsProcessed = Math.trunc(runWorkflowFor / (DELAY_MS / 1000));

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

function getAxiosInstance() {
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

async function fetchAllNameIds() {
    let skins = {};
    let start = 0;
    let maxAmount = Infinity;

    const itemListFromRender = await fetchAdditionalItemInfo();

    if (fsSync.existsSync(local_skins_to_name_id_path)) {
        try {
            const existingSkins = JSON.parse(await fs.readFile(local_skins_to_name_id_path, 'utf8'));
            start = await loadStartFrom('data/start_from_name_id.json');
            skins = existingSkins;
        } catch (err) {
            console.error(`Failed to read existing skins: ${err}`);
        }
    }

    if (itemListFromRender.length && skins) {
        if ((start + maxItemsProcessed) > itemListFromRender.length) {
            maxAmount = itemListFromRender.length;
        } else {
            maxAmount = start + maxItemsProcessed;
        }

        for (start; start < maxAmount; start++) {
            const currentItem = itemListFromRender[start];
            const currentItemName = currentItem.hash_name;
            const itemNameId = skins[currentItemName];
            await setStartFrom(start, 'data/start_from_name_id.json');

            if (itemListFromRender.length > 1 && (start + 1) >= itemListFromRender.length) {
                await setStartFrom(0, 'data/start_from_name_id.json');
                console.log(`Reached end of item list at index ${start}. Setting start_from to 0.`);
            }

            if (itemNameId) {
                console.log(`Skipping already fetched: ${currentItemName}`);
                ((itemListFromRender.length) > maxAmount) ? maxAmount++ : '';
                continue;
            } else if (!itemNameId && !currentItem.date_modified) {
                console.warn(`Not marketable item: ${currentItemName}, skipping.`);
                continue;
            }

            const fetchedItemNameId = await fetchItemNameId(currentItemName)
            if (fetchedItemNameId) {
                skins[currentItemName] = fetchedItemNameId;
            }

            console.log(`Fetched ${currentItemName} ${start}/${maxAmount - 1}`);
            await fs.writeFile(local_skins_to_name_id_path, JSON.stringify(skins, null, 2));
            await sleep(DELAY_MS);
        }
    }
}

async function fetchItemNameId(currentItemName, appId = 730) {
    const url = `${BASE_URL}/listings/730/${currentItemName}`;

    try {
        const axiosInstance = getAxiosInstance();
        const { data: html } = await retry(() => axiosInstance.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            }
        }));
        const match = html.match(/Market_LoadOrderSpread\(( \d+ )\)/);

        if (match) {
            const itemNameId = match[1];
            console.log(`✅ Found item_nameid: ${itemNameId}`);
            return Number(itemNameId);
        } else {
            console.error(`❌ item_nameid not found in HTML. item name = ${currentItemName}`);
        }
    } catch (err) {
        console.error(`Error fetching item ${currentItemName}: ${err.message}`);
    }
}

async function loadStartFrom(pathToStart = 'data/start_from.json') {
  const path = pathToStart;
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

async function setStartFrom(startFrom, pathToStart = 'data/start_from.json') {
  const path = pathToStart;
  const startFromToSave = { start_from: startFrom };
  if (!existsSync(path)) return {};
  try {
    await fs.writeFile(path, JSON.stringify(startFromToSave, null, 2));
  } catch {
    console.error(`Failed to save start_from to ${path}`);
  }
}

async function main() {
    await fetchAllNameIds();
}

main();
