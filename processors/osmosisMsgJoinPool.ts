import bigDecimal from "js-big-decimal";
import { groupAttributesIntoBlocks } from "../utils/groupAttributesIntoBlocks";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";

export async function osmosisMsgJoinPool(logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "transfer") {
        const groups = groupAttributesIntoBlocks(attributes);
        const [[, , { value: coinIn }], [, , { value: coinOut }]] = groups;
        const denomsIn = getDenominationsValueList(coinIn);
        const denomsOut = getDenominationsValueList(coinOut);
        const regex = /\d+(.+)/;
        const coinOutAmount = bigDecimal.divide(
          denomsOut[0][0],
          getDenominator(18),
          18
        );
        const coinOutDenom = coinOut.match(regex)?.[1];

        transactions.push({
          type: "Swap",
          description: `Received ${coinOutAmount} ${coinOutDenom} Pool Token`,
          receivedAmount: coinOutAmount,
          receivedAsset: coinOutDenom,
        });

        for (const [amount, denom] of denomsIn) {
          const { symbol, decimals } = await getIbcDenomination(denom);
          const tokenAmount = bigDecimal.divide(
            amount,
            getDenominator(decimals),
            decimals
          );

          transactions.push({
            sentAmount: tokenAmount,
            sentAsset: symbol,
            description: `Deposit ${tokenAmount} ${symbol} into Liquidity Pool`,
            type: "Swap",
          });
        }
      }
    }
  }

  return transactions;
}
