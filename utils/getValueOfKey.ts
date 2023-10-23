export function getValueOfKey(
  arr: Array<{ key: string; value: string }>,
  key: string
) {
  return arr.find((item) => item.key === key);
}
