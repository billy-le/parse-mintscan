import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "../utils/getIbcDenominations";
import { getDenominator } from "../utils/getDenominator";
import { groupAttributesIntoBlocks } from "../utils/groupAttributesIntoBlocks";
import { getDenominationsValueList } from "../utils/getDenominationsValueList";

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
          const parts = denom.split("/");
          if (receiver === address) {
            const { symbol, decimals } = parts.includes("ibc")
              ? await getIbcDenomination(denom)
              : await getIbcDenomination(parts[parts.length - 1]);
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
        } else if (type === "claim") {
          const groups = groupAttributesIntoBlocks(attributes);
          for (const group of groups) {
            const amount = group.find(({ key }) => key === "amount");
            if (!amount) break;
            const denoms = getDenominationsValueList(amount.value);
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
                type: "Income",
                description: "Airdrop",
              });
            }
          }
        }
      }
    }
  }

  return transactions;
}
