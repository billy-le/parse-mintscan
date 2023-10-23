import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";
import { getValueOfKey } from "../utils/getValueOfKey";
import { getFees } from "../utils/getFees";

export async function ibcMsgTransfer(
  address: string,
  baseSymbol: string,
  tx: Tx,
  logs: Log[]
) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    const transfers = events.filter(({ type }) => type === "transfer");
    const [, , { value: timeoutHeight }] =
      events.find(({ type }) => type === "send_packet")?.attributes ?? [];

    for (const { attributes } of transfers) {
      const recipient = getValueOfKey(attributes, "recipient");
      const sender = getValueOfKey(attributes, "sender");
      const amount = getValueOfKey(attributes, "amount");
      const denoms = amount
        ? getDenominationsValueList(amount.value)
        : [["0", "Unknown"]];

      if (recipient?.value === address) {
        for (const [amount, denom] of denoms) {
          const { symbol, decimals } = await getIbcDenomination(denom);
          const tokenAmount = bigDecimal.divide(
            amount,
            getDenominator(decimals),
            decimals
          );
          transactions.push({
            type: "Deposit",
            description: `Received from ${sender?.value}`,
            receivedAmount: tokenAmount,
            receivedAsset: symbol,
            meta: `timeout_height: ${timeoutHeight}`,
          });
        }
      } else if (sender?.value === address) {
        const ibcRecipient = events
          .find(({ type }) => type === "ibc_transfer")
          ?.attributes?.find(({ key }) => key === "receiver");
        for (const [amount, denom] of denoms) {
          const { symbol, decimals } = await getIbcDenomination(denom);
          const tokenAmount = bigDecimal.divide(
            amount,
            getDenominator(decimals),
            decimals
          );
          transactions.push({
            type: "Transfer",
            description: `Sent to ${ibcRecipient?.value}`,
            sentAmount: tokenAmount,
            sentAsset: symbol,
            meta: `timeout_height: ${timeoutHeight}`,
          });
        }

        transactions.push({
          type: "Expense",
          description: "Fee for IBC Transfer",
          feeAmount: await getFees(tx),
          feeAsset: baseSymbol,
        });
      }
    }
  }

  return transactions;
}
