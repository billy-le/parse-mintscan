import bigDecimal from "js-big-decimal";
import { groupAttributesIntoBlocks } from "../utils/groupAttributesIntoBlocks";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";

export async function osmosisMsgJoinSwapExternAmountIn(logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "transfer") {
        const [senderInfo, receiverInfo] =
          groupAttributesIntoBlocks(attributes);
        const [, , { value: coinIn }] = senderInfo;
        const [, , { value: coinOut }] = receiverInfo;

        const [[senderAmount, senderDenom]] = getDenominationsValueList(coinIn);
        const { symbol: coinInSymbol, decimals: coinInDecimals } =
          await getIbcDenomination(senderDenom);
        const coinInAmount = bigDecimal.divide(
          senderAmount,
          getDenominator(coinInDecimals),
          coinInDecimals
        );

        const coinoutDenoms = getDenominationsValueList(coinOut);

        const regex = /\d+(.+)/;
        const [[_coinOutAmount]] = coinoutDenoms;
        const coinOutDenom = coinOut.match(regex)?.[1];
        const coinOutAmount = bigDecimal.divide(
          _coinOutAmount,
          getDenominator(18),
          18
        );

        transactions.push({
          type: "Swap",
          description: `Swapped from Liquidity Pool`,
          sentAmount: coinInAmount,
          sentAsset: coinInSymbol,
          receivedAmount: coinOutAmount,
          receivedAsset: coinOutDenom,
        });
      }
    }
  }
  return transactions;
}
