import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";
import { getDenominator } from "../utils/getDenominator";

export async function msgRecvPacket(address: string, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    const sender = events
      .find(({ type }) => type === "recv_packet")
      ?.attributes?.find(({ key }) => key === "packet_data")?.[
      "value__@transfer"
    ]?.sender;

    for (const { type, attributes } of events) {
      if (type === "transfer") {
        const keys = new Set<string>();
        attributes.forEach(({ key }) => keys.add(key));
        for (let i = 0; i < attributes.length; i += keys.size) {
          const [{ value: recipient }, , { value: amount }] = attributes.slice(
            i,
            (i += keys.size)
          );

          if (recipient === address) {
            const denoms = getDenominationsValueList(amount);
            for (const [amount, denom] of denoms) {
              const { symbol, decimals } = await getIbcDenomination(denom);
              const tokenAmount = bigDecimal.divide(
                amount,
                getDenominator(decimals),
                decimals
              );

              transactions.push({
                receivedAmount: tokenAmount,
                receivedAsset: symbol,
                description: `Received from ${sender}`,
                type: "Deposit",
              });
            }
          }
        }
      }
    }
  }

  return transactions;
}
