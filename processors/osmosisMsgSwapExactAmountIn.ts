import bigDecimal from "js-big-decimal";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";

export async function osmosisMsgSwapExactAmountIn(logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "token_swapped") {
        const [, , , { value: tokensIn }, { value: tokensOut }] = attributes;

        const [[inAmount, inDenom]] = getDenominationsValueList(tokensIn);
        const [[outAmount, outDenom]] = getDenominationsValueList(tokensOut);
        const { symbol: inSymbol, decimals: inDecimals } =
          await getIbcDenomination(inDenom);
        const { symbol: outSymbol, decimals: outDecimals } =
          await getIbcDenomination(outDenom);

        const inValue = bigDecimal.divide(
          inAmount,
          getDenominator(inDecimals),
          inDecimals
        );
        const outValue = bigDecimal.divide(
          outAmount,
          getDenominator(outDecimals),
          outDecimals
        );

        transactions.push({
          type: "Swap",
          sentAmount: inValue,
          sentAsset: inSymbol,
          receivedAmount: outValue,
          receivedAsset: outSymbol,
        });
      }
    }
  }
  return transactions;
}
