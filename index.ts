import fs from "fs";
import { chain } from "stream-chain";
import { parser } from "stream-json";
import { streamArray } from "stream-json/streamers/StreamArray";
import csvParser from "csv-parser";
import { stringify as csvStringify } from "csv-stringify/sync";
import processTransaction from "./processTransaction.ts";

const walletAddress = process.argv[2];
if (!walletAddress) throw new Error("no wallet provided as argument");

const network = "cosmos";
const csvFilename = `./csv/${network}_data.csv`;
const timeoutFilename = "timeout_txs.txt";

// fetch("https://chains.cosmos.directory/")
//   .then((res) => {
//     if (res.ok) {
//       return res.json();
//     } else {
//       throw new Error();
//     }
//   })
//   .then(async (data) => {
//     const d = await fs.promises.readFile("ibc-denominations.json");
//     let denoms = JSON.parse(d.toString());

//     for (const { denom, symbol, assets, decimals } of data.chains) {
//       if (!denoms[denom]) {
//         denoms[denom] = { symbol, decimals };
//       }

//       if (assets) {
//         for (const { denom, symbol, decimals } of assets) {
//           if (!denoms[denom]) {
//             denoms[denom] = { symbol, decimals };
//           }
//         }
//       }
//     }

//     denoms = Object.keys(denoms)
//       .sort()
//       .reduce((acc, key) => {
//         acc[key] = denoms[key];
//         return acc;
//       }, {});

//     await fs.promises.writeFile(
//       "ibc-denominations.json",
//       JSON.stringify(denoms, null, 2)
//     );
//   })
//   .catch((err) => {
//     console.log(err);
//   });

chain([
  fs.createReadStream("./headers/koinly.txt"),
  (data) => {
    return data.toString() + "\n";
  },
  fs.createWriteStream(csvFilename),
]);

const msgTypes = new Set<string>();

let txCount = 0;
const pipeline = chain([
  fs.createReadStream(`./data/${network}.json`),
  parser(),
  streamArray(),
  async (data) => {
    txCount++;
    const transactions = [];
    const transaction = data.value;
    const mainTx = await processTransaction(walletAddress, transaction);
    const tx = transaction.tx[transaction.tx["@type"].replaceAll(".", "-")];
    tx.body.messages.forEach((msg: Record<string, any>) => {
      msgTypes.add(msg["@type"]);
    });
    transactions.push(mainTx);
    return transactions.join("");
  },
  fs.createWriteStream(csvFilename, { flags: "a" }),
]);

pipeline.on("end", async () => {
  console.log(msgTypes);
  console.log("data.csv created", `\nprocessed ${txCount} transactions`);

  // remove txs from timeouts and meta from csv
  let records: Array<Record<string, string>> = [];
  fs.createReadStream(csvFilename)
    .pipe(csvParser())
    .on("data", (data) => {
      try {
        const timeoutData = fs.readFileSync(timeoutFilename);
        const timeouts = timeoutData.toString().split("\n");

        if (!data.Meta || !timeouts.includes(data.Meta)) {
          delete data.Meta;
          records.push(data);
        }
      } catch (err) {}
    })
    .on("end", () => {
      if (records.length) {
        const headers = Object.keys(records[0]).reduce((acc, key) => {
          acc[key] = key;
          return acc;
        }, {} as (typeof records)[number]);
        records.unshift(headers);
        const output = csvStringify(records);
        fs.writeFileSync(csvFilename, output);
      } else {
        console.log("no timeout txs found!");
      }

      // delete timeout file silently
      fs.unlink(timeoutFilename, (err) => {
        if (err) return;
      });
    });
});
