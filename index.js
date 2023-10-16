const fs = require("fs");
const processTransaction = require("./processTransaction.js");
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");
const csvParser = require("csv-parser");
const csvStringify = require("csv-stringify/sync");

const walletAddress = process.argv[2];
if (!walletAddress) throw new Error("no wallet provided as argument");

const csvFilename = "./csv/cosmos_data.csv";
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

//     for (const { denom, symbol, assets } of data.chains) {
//       if (!denoms[denom]) {
//         denoms[denom] = symbol;
//       }

//       if (assets) {
//         for (const { denom, symbol } of assets) {
//           if (!denoms[denom]) {
//             denoms[denom] = symbol;
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
//       JSON.stringify(denoms)
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

const msgTypes = new Set();

let txCount = 0;
const pipeline = chain([
  fs.createReadStream("./data/cosmos.json"),
  parser(),
  streamArray(),
  async (data) => {
    txCount++;
    const transactions = [];
    const transaction = data.value;
    const mainTx = await processTransaction(walletAddress, transaction);
    const tx = transaction.tx[transaction.tx["@type"].replaceAll(".", "-")];
    tx.body.messages.forEach((msg) => {
      msgTypes.add(msg["@type"]);
    });
    transactions.push(mainTx);
    return transactions.join("");
  },
  fs.createWriteStream(csvFilename, { flags: "a" }),
]);

pipeline.on("end", async () => {
  console.log("data.csv created", `\nprocessed ${txCount} transactions`);

  // remove txs from timeouts and meta from csv
  let records = [];
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
        }, {});
        records.unshift(headers);
        const output = csvStringify.stringify(records);
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
