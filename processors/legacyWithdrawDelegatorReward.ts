import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getValueOfKey } from "../utils/getValueOfKey";

export async function legacyWithdrawDelegatorReward(
  address: string,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  const rewards: Record<string, string> = {};
  for (const log of logs) {
    const transferInfo =
      log.events.find(({ type }) => type === "transfer")?.attributes ?? [];
    const recipient = getValueOfKey(transferInfo, "recipient");
    const amount = getValueOfKey(transferInfo, "amount");
    const denoms = amount
      ? getDenominationsValueList(amount?.value)
      : [["0", "Unknown"]];

    if (recipient?.value === address) {
      for (const [amount, denom] of denoms) {
        const tokenInfo = await getIbcDenomination(denom);
        const tokenAmount = bigDecimal.divide(
          amount,
          getDenominator(tokenInfo.decimals),
          tokenInfo.decimals
        );

        if (!rewards[tokenInfo.symbol]) {
          rewards[tokenInfo.symbol] = "";
        }

        rewards[tokenInfo.symbol] = bigDecimal.add(
          rewards[tokenInfo.symbol],
          tokenAmount
        );
      }
    }
  }

  for (const token in rewards) {
    transactions.push({
      type: "Income",
      description: "Claimed Rewards",
      receivedAmount: rewards[token],
      receivedAsset: token,
    });
  }

  return transactions;
}
