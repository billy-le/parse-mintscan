import bigDecimal from "js-big-decimal";
import { getIbcDenomination } from "./getIbcDenominations";
import { getDenominator } from "./getDenominator";

export async function getFees(tx: Tx) {
  const type: string = (tx["@type"] as string).replaceAll(".", "-");
  const { auth_info } = (tx as TxType)[type];
  const fee = auth_info.fee.amount[0];
  const feeToken = await getIbcDenomination(fee.denom);
  return bigDecimal.divide(
    fee.amount,
    getDenominator(feeToken.decimals),
    feeToken.decimals
  );
}
