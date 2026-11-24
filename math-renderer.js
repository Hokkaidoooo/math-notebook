"use strict";

window.MathNotebookMath = Object.freeze({
  render(element, reportError) {
    if (typeof window.renderMathInElement !== "function") {
      throw new Error("公式组件未载入，请检查 vendor 文件夹是否完整。");
    }
    window.renderMathInElement(element, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false }
      ],
      throwOnError: false,
      errorColor: "#a64232",
      errorCallback: message => reportError("公式排版失败：" + message),
      trust: false,
      strict: "warn"
    });
  }
});
