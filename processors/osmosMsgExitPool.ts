import bigDecimal from "js-big-decimal";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { groupAttributesIntoBlocks } from "../utils/groupAttributesIntoBlocks";
import { getDenominator } from "../utils/getDenominator";

export async function osmosisMsgExitPool(logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "transfer") {
        const [outInfo, inInfo] = groupAttributesIntoBlocks(attributes);
        const [, , { value: outDenom }] = outInfo;
        const outDenoms = getDenominationsValueList(outDenom);
        for (const [amount, denom] of outDenoms) {
          const { symbol, decimals } = await getIbcDenomination(denom);
          const tokenAmount = bigDecimal.divide(
            amount,
            getDenominator(decimals),
            decimals
          );

          transactions.push({
            type: "Swap",
            description: "Removed Tokens from Liquidity Pool",
            receivedAmount: tokenAmount,
            receivedAsset: symbol,
          });
        }

        const [, , { value: inDenom }] = inInfo;
        const [[inValue]] = getDenominationsValueList(inDenom);
        const regex = /\d+(.+)/;
        const poolToken = inDenom.match(regex)?.[1];
        const poolAmount = bigDecimal.divide(inValue, getDenominator(18), 18);

        transactions.push({
          type: "Swap",
          sentAmount: poolAmount,
          sentAsset: poolToken,
          description: "Swap GAMM Pool tokens",
        });
      }
    }
  }
  return transactions;
}
