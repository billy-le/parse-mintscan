import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";

export async function legacySwapWithinBatch(logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const log of logs) {
    const swapWithinBranch = log.events.filter(
      ({ type }) => type === "swap_within_batch"
    );

    for (const {
      attributes: [
        ,
        ,
        ,
        ,
        { value: offerCoinDenom },
        { value: offerCoinAmount },
        { value: offerCoinFee },
        { value: demandCoinDenom },
        { value: orderPrice },
      ],
    } of swapWithinBranch) {
      const { symbol: offerSymbol, decimals: offerDecimals } =
        await getIbcDenomination(offerCoinDenom);
      const offerCoinValue = bigDecimal.divide(
        offerCoinAmount,
        getDenominator(offerDecimals),
        offerDecimals
      );
      const offerFee = bigDecimal.divide(
        offerCoinFee,
        getDenominator(offerDecimals),
        offerDecimals
      );
      const { symbol: demandSymbol, decimals: demandDecimals } =
        await getIbcDenomination(demandCoinDenom);
      const amount = bigDecimal.divide(
        bigDecimal.multiply(offerCoinValue, orderPrice),
        1,
        demandDecimals
      );
      transactions.push({
        type: "Swap",
        description: `Swapped ${offerCoinValue} ${offerSymbol} for ${amount} ${demandSymbol}`,
        sentAmount: offerCoinValue,
        sentAsset: offerSymbol,
        receivedAmount: amount,
        receivedAsset: demandSymbol,
        feeAsset: offerSymbol,
        feeAmount: offerFee,
      });
    }
  }

  return transactions;
}
