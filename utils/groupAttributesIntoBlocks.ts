export function groupAttributesIntoBlocks(
  attributes: Log["events"][number]["attributes"]
) {
  const attrLen = attributes.length;

  const groups: Array<typeof attributes> = [];

  for (let i = 0; i < attrLen; ) {
    const startKey = attributes[i].key;
    for (let j = i + 1; j < attrLen; j++) {
      const compareKey = attributes[j].key;
      if (startKey === compareKey) {
        const group = attributes.slice(i, j);
        i = j - 1;
        groups.push(group);
        break;
      }
      if (j === attrLen - 1) {
        const group = attributes.slice(i, j + 1);
        groups.push(group);
        i = attrLen;
        break;
      }
    }
    i++;
  }
  return groups;
}
