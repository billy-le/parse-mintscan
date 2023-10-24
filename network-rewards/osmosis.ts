import path from "path";
import { sleep } from "bun";
import { writeFile } from "node:fs/promises";

export async function getRewards(address: string) {
  const rewards: Record<string, Array<{ amount: number; day: string }>> = {};

  const data = await fetch(
    `https://api-osmosis-chain.imperator.co/lp/v1/rewards/token/${address}`
  ).then((res) => {
    if (res.ok) {
      return res.json() as unknown as Array<{ token: string }>;
    }
    return undefined;
  });
  if (data) {
    for (const { token } of data) {
      const rewardsData = await fetch(
        `https://api-osmosis-chain.imperator.co/lp/v1/rewards/historical/${address}/${token}`
      ).then((res) => {
        if (res.ok) {
          return res.json() as unknown as (typeof rewards)[string];
        }
        return undefined;
      });
      if (rewardsData) {
        rewards[token] = rewardsData;
      }
      await sleep(500);
    }
  }

  await writeFile(
    path.resolve(__dirname, "./osmosis_rewards.json"),
    JSON.stringify(rewards, null, 2)
  );

  return rewards;
}
