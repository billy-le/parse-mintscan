export function getDenominationsValueList(value: string) {
  let denoms: Array<[string, string]> = [];
  const parts = value.split(",");

  for (const part of parts) {
    let denom: string | undefined = "";
    if (part.includes("ibc/")) {
      denom = part.split(/^(\d+)(.+)/).filter((x) => x)[1];
    } else {
      denom = part.match(/[a-z]+/gi)?.[0];
    }
    const amount = part.match(/\d+/gi);

    denoms.push([amount?.[0] ?? "0", denom ?? "Unknown"]);
  }

  return denoms;
}
