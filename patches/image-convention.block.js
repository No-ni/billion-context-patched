// --- image convention: a picture is expensive, look once ---------------------
// Splices a constant paragraph onto the tail of the standing compression
// prompt (see "image prompt" in scripts/patch-bili-build.mjs). Constant text
// keeps the cached prefix warm; conditional text would blow the whole prefix
// away on every flip, so this is injected unconditionally and gated only by
// config.
//
// Off switch: imagePrompt:false in the config file, or BILI_IMAGE_PROMPT=0.

var BILI_IMAGE_CONVENTION_TEXT = "\u5173\u4e8e\u56fe\u50cf\uff1a\u80fd\u7528\u6587\u5b57\u6216\u6570\u636e\u770b\u5230\u7684\u4fe1\u606f\uff0c\u5c31\u4e0d\u8981\u901a\u8fc7\u770b\u56fe\u83b7\u53d6\u2014\u2014\u56fe\u7247\u6709\u4f53\u79ef\u548c\u91cd\u4f20\u6210\u672c\uff0c\u4e14\u770b\u8fc7\u540e\u4e0d\u4f1a\u4e00\u76f4\u4fdd\u7559\u3002\u000a\u00b7 \u53ea\u6709\u786e\u5b9e\u9700\u8981\u201c\u770b\u201d\uff08\u7248\u9762\u3001\u914d\u8272\u3001\u5e03\u5c40\u3001\u56fe\u5f62\u7ec6\u8282\uff09\u65f6\u624d\u51fa\u56fe\u6216\u8bfb\u56fe\u3002\u000a\u00b7 \u8981\u770b\u5c31\u4e00\u6b21\u770b\u591f\uff1a\u540c\u4e00\u7248\u9762\u4e0d\u8981\u91cd\u590d\u6e32\u67d3\uff1b\u6539\u52a8\u540e\u5148\u81ea\u67e5\u5dee\u5f02\uff0c\u786e\u8ba4\u5fc5\u8981\u518d\u770b\u3002\u000a\u00b7 \u51fa\u56fe\u591f\u5224\u65ad\u5373\u53ef\uff0c\u4e0d\u8981\u6574\u9875\u9ad8\u5206\u8fa8\u7387\uff1b\u80fd\u88c1\u526a\u5c31\u88c1\u526a\u3002\u000a\u00b7 \u56fe\u662f\u4e34\u65f6\u7684\uff1a\u4f60\u770b\u8fc7\u4e4b\u540e\uff0c\u540e\u7eed\u8bf7\u6c42\u91cc\u5b83\u4f1a\u88ab\u66ff\u6362\u6210\u4e00\u884c\u5360\u4f4d\u8bf4\u660e\uff0c\u53ea\u6709\u4f60\u5199\u4e0b\u6765\u7684\u6587\u5b57\u4f1a\u7559\u4e0b\u3002\u770b\u5b8c\u8bf7\u628a\u4e8b\u60c5\u5199\u6210\u6587\u5b57\uff08\u7ed3\u8bba\u3001\u5dee\u5f02\u3001\u5f85\u529e\uff09\uff1b\u786e\u5b9e\u9700\u8981\u56de\u770b\u65f6\uff0c\u7528 acp_read_original_image(\"<ref>\") \u6309\u5f15\u7528\u53d6\u56de\u3002";

function biliImageConventionEnabled() {
  const raw = process.env.BILI_IMAGE_PROMPT;
  if (raw !== void 0) return !(raw === "0" || raw === "false" || raw === "off");
  try {
    const cfg = loadConfigFile();
    if (isObj4(cfg) && cfg.imagePrompt === false) return false;
  } catch (err) {}
  return true;
}

function biliImageConventionText() {
  if (BILI_IMAGE_CONVENTION_TEXT === "") return "";
  if (!biliImageConventionEnabled()) return "";
  return "\u000a\u000a" + BILI_IMAGE_CONVENTION_TEXT;
}
