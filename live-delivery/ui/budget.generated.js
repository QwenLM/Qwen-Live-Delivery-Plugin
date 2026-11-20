"use strict";
var QWEN_LD_BUDGET = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/delivery/budget.ts
  var budget_exports = {};
  __export(budget_exports, {
    requestedBudget: () => requestedBudget
  });
  function requestedBudget(text) {
    const duration = "(\\d+(?:\\.\\d+)?)\\s*(\u79D2|\u5206\u949F|\u5206|\u5C0F\u65F6|\u5929|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])";
    const patterns = [
      new RegExp(
        "(?:\u603B\u6267\u884C\u65F6\u95F4|\u603B\u65F6\u95F4|\u603B\u65F6\u957F|\u6267\u884C\u4E0A\u9650|\u65F6\u95F4\u9884\u7B97|\u603B\u9884\u7B97|total (?:time|budget)|time budget)\\s*(?:\u4E3A|\u662F|[:\uFF1A=]|\u4E0D\u8D85\u8FC7|\u6700\u591A|\u9650\u5236\u4E3A)?\\s*" + duration,
        "ig"
      ),
      new RegExp(
        "(?:\u8BF7)?(?:\u5728|\u7528|\u9650\u65F6)\\s*" + duration + "\\s*(?:\u5185)?(?:\u5B8C\u6210|\u505A|\u5236\u4F5C|\u5B9E\u73B0|\u4EA4\u4ED8)",
        "ig"
      ),
      new RegExp(
        "(?:finish|complete|deliver)\\b[^.\u3002\\n]{0,40}?\\b(?:in|within)\\s*" + duration + "\\b",
        "ig"
      )
    ];
    const units = {
      \u79D2: 1,
      \u5206\u949F: 60,
      \u5206: 60,
      \u5C0F\u65F6: 3600,
      \u5929: 86400,
      s: 1,
      m: 60,
      h: 3600,
      d: 86400
    };
    const found = patterns.flatMap((pattern) => [...text.matchAll(pattern)]).sort((a, b) => a.index - b.index);
    const match = found.at(-1);
    if (!match) return void 0;
    const unit = match[2].toLowerCase();
    const multiplier = units[unit] ?? (/^s/.test(unit) ? 1 : /^m/.test(unit) ? 60 : /^h/.test(unit) ? 3600 : 86400);
    const seconds = Math.round(Number(match[1]) * multiplier);
    return seconds >= 30 && seconds <= 604800 ? seconds : void 0;
  }
  return __toCommonJS(budget_exports);
})();
