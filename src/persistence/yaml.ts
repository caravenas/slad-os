import YAML from "yaml";

export function stringifyYaml(value: unknown): string {
  return YAML.stringify(value, null, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    nullStr: "null",
  });
}

export function parseYaml(text: string): unknown {
  return YAML.parse(text);
}
