import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";

export async function msgRecvPacket(address: string, logs: Log[]) {
  const transactions: Partial<Transaction>[] = [];
  for (const { events } of logs) {
    const recvPackets = events.filter((e) => e.type === "recv_packet");

    if (recvPackets.length) {
      for (const { type, attributes } of events) {
        if (type === "recv_packet") {
          const [packetData] = attributes;
          const { amount, denom, receiver, sender } =
            packetData["value__@transfer"];
          if (receiver === address) {
            const { symbol, decimals } = await getIbcDenomination(denom);
            const tokenAmount = bigDecimal.divide(
              amount,
              getDenominator(decimals),
              decimals
            );
            transactions.push({
              type: "Deposit",
              receivedAmount: tokenAmount,
              receivedAsset: symbol,
              description: `Received from ${sender}`,
            });
          }
        }
      }
    }
  }

  return transactions;
}
