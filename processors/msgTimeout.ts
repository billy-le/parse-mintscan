import path from "node:path";
import fs from "fs";

export async function msgTimout(network: string, logs: Log[]) {
  const filename = path.resolve(__dirname, `../${network}_timeout_txs.txt`);
  for (const { events } of logs) {
    const timeoutPacket = events.find(({ type }) => type === "timeout_packet");
    if (timeoutPacket) {
      const [{ value: timeoutHeight }] = timeoutPacket.attributes;
      const timeout = `timeout_height: ${timeoutHeight}`;
      try {
        // when an ibc transaction timeouts, we need to remove the entry from the data.csv
        // so we store all timeout txs in a file
        const txs = await fs.promises.readFile(filename, "utf-8");
        if (!txs.includes(timeout)) {
          await fs.promises.writeFile(filename, `${timeout}\n`, {
            flag: "a",
          });
        }
      } catch (err) {
        await fs.promises.writeFile(filename, `${timeout}\n`);
      }
    }
  }
}
