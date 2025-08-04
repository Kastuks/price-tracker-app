import dotenv from 'dotenv';
dotenv.config();
import fsSync, { promises as fs } from 'fs';

const batchSize = 8;
const savePathLatest = 'data/prices_latest_snapshot.json';
const savePathSnapshot = `data/price_snapshots/price_snapshot_${new Date().toISOString().replace(/:/g, '_')}.json`;

async function fetchAllItemPricesAndSnapshot() {
    let allPricesConcat = [];
    for (let i = 1; i <= batchSize; i++) {
        const dataPath = `data/cs2_prices/cs2_items_${i}.json`;
        if (fsSync.existsSync(dataPath)) {
            const existing = JSON.parse(await fs.readFile(dataPath, 'utf8'));
            allPricesConcat = [...allPricesConcat, ...existing ];
        }
    }
    await fs.writeFile(savePathLatest, JSON.stringify(allPricesConcat, null, 2));
    await fs.writeFile(savePathSnapshot, JSON.stringify(allPricesConcat, null, 2));
}

async function main() {
    await fetchAllItemPricesAndSnapshot();
}

main();