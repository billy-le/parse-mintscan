import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";

export async function recvPacket(address: string, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    for (const { type, attributes } of events) {
      if (type === "recv_packet") {
        const [packetData] = attributes;
        const { amount, denom, receiver, sender } =
          packetData["value__@transfer"];
        if (receiver === address) {
          const denomParts = denom.split("/");
          const token = denomParts[denomParts.length - 1];
          const { symbol, decimals } = await getIbcDenomination(token);
          const tokenAmount = bigDecimal.divide(
            amount,
            getDenominator(decimals),
            decimals
          );
          transactions.push({
            receivedAmount: tokenAmount,
            receivedAsset: symbol,
            type: "Deposit",
            description: `Received from ${sender}`,
          });
        }
      }
    }
  }

  return transactions;
}
