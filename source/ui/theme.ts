export interface Theme {
  primary(text: string): string;
  accent(text: string): string;
  secondary(text: string): string;
  border(text: string): string;
  warning(text: string): string;
  success(text: string): string;
  error(text: string): string;
  selection(text: string): string;
  reset: string;
}

const style = (enabled: boolean, code: string) => (text: string) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

export function createTheme(color = !process.env.NO_COLOR): Theme {
  return {
    primary: style(color, "1"),
    accent: style(color, "1;36"),
    secondary: style(color, "2"),
    border: style(color, "2;37"),
    warning: style(color, "33"),
    success: style(color, "32"),
    error: style(color, "31"),
    selection: style(color, "7"),
    reset: color ? "\x1b[0m" : "",
  };
}
