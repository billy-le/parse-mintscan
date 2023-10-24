import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { exec } from "node:child_process";

const execPromise = promisify(exec);

export async function getIbcDenomination(pathHash: string) {
  if (!pathHash) throw new Error("pathHash not provided");
  const filePath = path.resolve(__dirname, "../ibc-denominations.json");

  try {
    const file = await readFile(filePath);
    const ibcDenominations = JSON.parse(file.toString());

    if (ibcDenominations[pathHash]) {
      return ibcDenominations[pathHash];
    }
    const { stdout, stderr } = await execPromise(
      `$GOPATH/bin/gaiad query ibc-transfer denom-trace ${pathHash} --node https://cosmos-rpc.quickapi.com:443`
    );
    if (stderr) {
      throw new Error(stderr);
    }

    if (stdout) {
      const token = stdout
        .split("\n")
        .find((part) => part.includes("base_denom"))
        ?.replaceAll(/base_denom:/gi, "")
        ?.replaceAll(" ", "");

      ibcDenominations[pathHash] = { symbol: token, decimals: 6 };

      await writeFile(filePath, JSON.stringify(ibcDenominations, null, 2));
      return ibcDenominations[pathHash];
    }
  } catch (err) {
    console.log(err);
    const file = await readFile(filePath);
    const ibcDenominations = JSON.parse(file.toString());
    ibcDenominations[pathHash] = { symbol: pathHash, decimals: 6 };
    await writeFile(filePath, JSON.stringify(ibcDenominations, null, 2));

    return { symbol: "Unknown", decimals: 0 };
  }
}
