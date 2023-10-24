import fs from "fs";
import path from "path";
import bigDecimal from "js-big-decimal";
import csvParser from "csv-parser";

export function getBalanceSheet(network: string) {
  const balanceSheet: Record<
    string,
    {
      sent: string;
      received: string;
      fees: string;
      endingBalance: string;
    }
  > = {};

  fs.createReadStream(path.resolve(__dirname, `../csv/${network}_data.csv`))
    .pipe(csvParser())
    .on("data", (data) => {
      const sentAsset = data["Sent Currency"];
      const sentAmount = data["Sent Amount"];
      const receivedAmount = data["Received Amount"];
      const receivedAsset = data["Received Currency"];
      const feeAmount = data["Fee Amount"];
      const feeAsset = data["Fee Currency"];

      if (sentAsset) {
        if (!balanceSheet[sentAsset]) {
          balanceSheet[sentAsset] = {
            sent: "0",
            fees: "0",
            received: "0",
            endingBalance: "0",
          };
        }

        balanceSheet[sentAsset] = {
          ...balanceSheet[sentAsset],
          sent: bigDecimal.add(balanceSheet?.[sentAsset].sent, sentAmount),
        };
      }

      if (feeAsset) {
        if (!balanceSheet[feeAsset]) {
          balanceSheet[feeAsset] = {
            sent: "0",
            fees: "0",
            received: "0",
            endingBalance: "0",
          };
        }

        balanceSheet[feeAsset] = {
          ...balanceSheet[feeAsset],
          fees: bigDecimal.add(balanceSheet?.[feeAsset].fees, feeAmount),
        };
      }

      if (receivedAsset) {
        if (!balanceSheet[receivedAsset]) {
          balanceSheet[receivedAsset] = {
            sent: "0",
            fees: "0",
            received: "0",
            endingBalance: "0",
          };
        }

        balanceSheet[receivedAsset] = {
          ...balanceSheet[receivedAsset],
          received: bigDecimal.add(
            balanceSheet?.[receivedAsset].received,
            receivedAmount
          ),
        };
      }

      for (const token in balanceSheet) {
        const tokenMeta = balanceSheet[token];
        const outflow = bigDecimal.add(tokenMeta.sent, tokenMeta.fees);
        balanceSheet[token].endingBalance = bigDecimal.subtract(
          tokenMeta.received,
          outflow
        );
      }
    })
    .on("end", () => {
      console.log("Your balance is:");
      console.log(balanceSheet);
    });
}
