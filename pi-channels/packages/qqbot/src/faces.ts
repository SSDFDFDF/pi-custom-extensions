/**
 * QQ faces for pi-channels (C2C-safe).
 *
 * Classic QQ chat lets you type slash codes like `/fendou` `/wx` `/微笑`.
 * Bot private chat cannot render real 小黄脸 embeds (`<emoji:id>` / faceType
 * show as raw text). We map slash codes + face tags → Unicode emoji.
 */

export type FaceSpec = {
  id: number;
  text: string;
  unicode: string;
};

/** Named faces used by status / notices. */
export const FACES = {
  smile: { id: 14, text: "微笑", unicode: "😊" },
  smug: { id: 4, text: "得意", unicode: "😏" },
  tear: { id: 5, text: "流泪", unicode: "😢" },
  sleep: { id: 8, text: "睡", unicode: "😴" },
  cry: { id: 9, text: "大哭", unicode: "😭" },
  awkward: { id: 10, text: "尴尬", unicode: "😅" },
  angry: { id: 11, text: "发怒", unicode: "😡" },
  playful: { id: 12, text: "调皮", unicode: "😜" },
  grin: { id: 13, text: "呲牙", unicode: "😁" },
  cool: { id: 16, text: "酷", unicode: "😎" },
  cute: { id: 21, text: "可爱", unicode: "🥰" },
  sweat: { id: 27, text: "流汗", unicode: "😓" },
  fendou: { id: 30, text: "奋斗", unicode: "💪" },
  dizzy: { id: 34, text: "晕", unicode: "😵" },
  bye: { id: 39, text: "再见", unicode: "👋" },
  rose: { id: 63, text: "玫瑰", unicode: "🌹" },
  heart: { id: 66, text: "爱心", unicode: "❤️" },
  like: { id: 76, text: "赞", unicode: "👍" },
  dislike: { id: 77, text: "弱", unicode: "👎" },
  handshake: { id: 78, text: "握手", unicode: "🤝" },
  clap: { id: 99, text: "鼓掌", unicode: "👏" },
  ok: { id: 124, text: "OK", unicode: "👌" },
  spin: { id: 125, text: "转圈", unicode: "🔄" },
  doge: { id: 179, text: "doge", unicode: "🐶" },
  lol: { id: 182, text: "笑哭", unicode: "😂" },
  facepalm: { id: 264, text: "捂脸", unicode: "🤦" },
  emm: { id: 270, text: "emm", unicode: "😐" },
  chigua: { id: 271, text: "吃瓜", unicode: "🍉" },
  moyu: { id: 285, text: "摸鱼", unicode: "🐟" },
  bixin: { id: 319, text: "比心", unicode: "💗" },
  bowLeft: { id: 302, text: "左拜年", unicode: "🙇" },
  bowRight: { id: 303, text: "右拜年", unicode: "🙏" },
} as const satisfies Record<string, FaceSpec>;

export type FaceName = keyof typeof FACES;

const ID_TO_FACE = new Map<number, FaceSpec>(
  Object.values(FACES).map((f) => [f.id, f]),
);

/**
 * Classic QQ slash shortcuts → unicode.
 * Includes full pinyin, short codes, and Chinese names.
 * Do NOT list control commands (abort/stop/next/continue/help/start).
 */
export const SLASH_FACE_TABLE: Record<string, string> = {
  // 奋斗
  fendou: "💪",
  奋斗: "💪",
  // 微笑 / 表情常用
  wx: "😊",
  微笑: "😊",
  smile: "😊",
  ":)": "😊",
  se: "😍",
  色: "😍",
  fd: "😶",
  发呆: "😶",
  dy: "😏",
  得意: "😏",
  ll: "😢",
  流泪: "😢",
  hx: "😳",
  害羞: "😳",
  含羞: "😳",
  bz: "🤐",
  闭嘴: "🤐",
  shui: "😴",
  睡: "😴",
  dk: "😭",
  大哭: "😭",
  gg: "😅",
  尴尬: "😅",
  fn: "😡",
  发怒: "😡",
  愤怒: "😡",
  tp: "😜",
  调皮: "😜",
  cy: "😁",
  呲牙: "😁",
  jy: "😲",
  惊讶: "😲",
  ng: "😞",
  难过: "😞",
  kuk: "😎",
  酷: "😎",
  cool: "😎",
  lengh: "😰",
  冷汗: "😰",
  zk: "🤯",
  抓狂: "🤯",
  tuu: "🤮",
  吐: "🤮",
  tx: "🤭",
  偷笑: "🤭",
  ka: "🥰",
  可爱: "🥰",
  cute: "🥰",
  baiy: "🙄",
  白眼: "🙄",
  am: "😤",
  傲慢: "😤",
  jie: "🤤",
  饥饿: "🤤",
  kun: "😪",
  困: "😪",
  jk: "😱",
  惊恐: "😱",
  lh: "😓",
  流汗: "😓",
  hanx: "😆",
  憨笑: "😆",
  db: "🪖",
  大兵: "🪖",
  fend: "💪",
  zhm: "🤬",
  咒骂: "🤬",
  yiw: "❓",
  疑问: "❓",
  xu: "🤫",
  嘘: "🤫",
  yun: "😵",
  晕: "😵",
  zhem: "😣",
  折磨: "😣",
  shuai: "💔",
  衰: "💔",
  kl: "💀",
  骷髅: "💀",
  qiao: "🔨",
  敲打: "🔨",
  zj: "👋",
  bye: "👋",
  再见: "👋",
  ch: "😅",
  擦汗: "😅",
  wipe: "😅",
  kb: "👃",
  抠鼻: "👃",
  dig: "👃",
  gz: "👏",
  鼓掌: "👏",
  handclap: "👏",
  clap: "👏",
  qd: "😳",
  糗大了: "😳",
  huaix: "😏",
  坏笑: "😏",
  zhh: "😤",
  左哼哼: "😤",
  yhh: "😤",
  右哼哼: "😤",
  hq: "🥱",
  哈欠: "🥱",
  bs: "😒",
  鄙视: "😒",
  wq: "🥺",
  委屈: "🥺",
  kk: "😢",
  快哭了: "😢",
  yx: "😈",
  阴险: "😈",
  qq: "😘",
  亲亲: "😘",
  xia: "😨",
  吓: "😨",
  kel: "🥺",
  可怜: "🥺",
  pz: "😣",
  撇嘴: "😣",
  // 手势 / 其它
  like: "👍",
  强: "👍",
  赞: "👍",
  弱: "👎",
  dislike: "👎",
  ok: "👌",
  握手: "🤝",
  handshake: "🤝",
  rose: "🌹",
  玫瑰: "🌹",
  heart: "❤️",
  爱心: "❤️",
  xin: "❤️",
  spin: "🔄",
  zhq: "🔄",
  转圈: "🔄",
  tiao: "🕺",
  跳跳: "🕺",
  doge: "🐶",
  笑哭: "😂",
  xk: "😂",
  捂脸: "🤦",
  wulian: "🤦",
  emm: "😐",
  吃瓜: "🍉",
  chigua: "🍉",
  摸鱼: "🐟",
  moyu: "🐟",
  比心: "💗",
  bixin: "💗",
  加油: "💪",
  jyoo: "💪",
  // english aliases
  cry: "😭",
  awkward: "😅",
  cool2: "😎",
};

/** Control / channel commands — never treat as faces. */
const RESERVED_SLASH = new Set([
  "abort",
  "stop",
  "next",
  "continue",
  "compact",
  "help",
  "start",
  "status",
  "channel-connect",
  "channel-disconnect",
  "channel-status",
  "channel-setup",
]);

/** @deprecated use SLASH_FACE_TABLE; kept for exports */
export const FACE_SLASH: Record<string, FaceName> = {
  fendou: "fendou",
  smile: "smile",
  spin: "spin",
  like: "like",
  cool: "cool",
  cry: "cry",
  awkward: "awkward",
  wx: "smile",
  奋斗: "fendou",
};

export function faceFromSlash(cmd: string): string | undefined {
  const key = cmd.replace(/^\//, "").trim();
  if (!key || RESERVED_SLASH.has(key.toLowerCase())) return undefined;
  // prefer exact (Chinese) then lowercased latin
  if (SLASH_FACE_TABLE[key]) return SLASH_FACE_TABLE[key];
  const lower = key.toLowerCase();
  if (SLASH_FACE_TABLE[lower]) return SLASH_FACE_TABLE[lower];
  const named = FACE_SLASH[lower];
  return named ? FACES[named].unicode : undefined;
}

export function emojiTag(id: number): string {
  return `<emoji:${id}>`;
}

export function faceTypeTag(spec: Pick<FaceSpec, "id" | "text">): string {
  const ext = Buffer.from(
    JSON.stringify({ text: spec.text }),
    "utf8",
  ).toString("base64");
  return `<faceType=1,faceId="${spec.id}",ext="${ext}">`;
}

export function faceMarkup(
  spec: FaceSpec,
  style: "unicode" | "emoji" | "faceType" = "unicode",
): string {
  if (style === "emoji") return emojiTag(spec.id);
  if (style === "faceType") return faceTypeTag(spec);
  return spec.unicode;
}

export function faceByName(
  name: FaceName,
  style: "unicode" | "emoji" | "faceType" = "unicode",
): string {
  return faceMarkup(FACES[name], style);
}

export function faceById(
  id: number,
  text = "表情",
  style: "unicode" | "emoji" | "faceType" = "unicode",
): string {
  const known = ID_TO_FACE.get(id);
  if (known) return faceMarkup(known, style);
  if (style === "emoji") return emojiTag(id);
  if (style === "faceType") return faceTypeTag({ id, text });
  return `[${text}]`;
}

/** Progress bubble: simple Unicode emoji + fixed phrase (C2C-safe). */
export function formatProgressFaceText(detail?: string): string {
  void detail; // tool detail ignored (user prefers simple status)
  return "💪 正在执行中";
}

export function formatFriendlyNotice(
  text: string,
  kind: "ok" | "info" | "warn" = "info",
): string {
  const face =
    kind === "ok"
      ? faceByName("smile", "unicode")
      : kind === "warn"
        ? faceByName("awkward", "unicode")
        : faceByName("fendou", "unicode");
  return `${face} ${text.trim()}`;
}

const FACE_TYPE_RE =
  /<faceType\s*=\s*1\s*,\s*faceId\s*=\s*["']?(\d+)["']?[^>]*>/gi;
const EMOJI_TAG_RE = /<emoji:(\d+)>/gi;

/** True if text has faceType/emoji tags (force plain). Slash codes handled via expand. */
export function containsFaceMarkup(text: string): boolean {
  FACE_TYPE_RE.lastIndex = 0;
  EMOJI_TAG_RE.lastIndex = 0;
  return FACE_TYPE_RE.test(text) || EMOJI_TAG_RE.test(text);
}

/**
 * Expand classic QQ slash face codes in free text.
 * `/fendou加油` → `💪加油`；whole-token preferred.
 */
export function expandSlashFaces(text: string): string {
  // Match /code where code is latin, chinese, or classic symbol forms
  return text.replace(
    /\/([A-Za-z][A-Za-z0-9]{0,15}|[\u4e00-\u9fff]{1,6}|:\)|:~|:\||:\$|:\(|:'\(|8-\)|:\+|B-\))/g,
    (full, code: string) => {
      if (RESERVED_SLASH.has(String(code).toLowerCase())) return full;
      const face = faceFromSlash(code);
      return face ?? full;
    },
  );
}

/**
 * C2C-safe outbound normalize:
 * faceType / <emoji:N> / /fendou → unicode
 */
export function preserveFaceContent(text: string): string {
  let out = text ?? "";
  out = out.replace(
    /<faceType\s*=\s*1\s*,\s*faceId\s*=\s*["']?(\d+)["']?[^>]*>/gi,
    (_m, id: string) => faceById(Number(id), "表情", "unicode"),
  );
  out = out.replace(/<emoji:(\d+)>/gi, (_m, id: string) =>
    faceById(Number(id), "表情", "unicode"),
  );
  out = expandSlashFaces(out);
  return out.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

export function stripFaceTags(text: string): string {
  return text
    .replace(/<emoji:\d+>/g, "")
    .replace(/<faceType=[^>]+>/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
