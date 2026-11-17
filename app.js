"use strict";

(() => {
  const PAGE_SIZE = 24;
  const DATA_SCHEMA_VERSION = 2;
  const SEARCH_DELAY_MS = 160;
  const REVIEW_STORAGE_KEY = "math-notebook-review-v1";
  const DIALOG_IDS = ["entry-dialog", "image-dialog", "reading-modes"];
  const READING_MODES = new Map([
    ["local", { label: "阅读方式", status: "本地笔记，随时回看" }],
    ["online", { label: "在线阅读", status: "在线阅读 · 题图按需加载" }],
    ["offline", { label: "离线阅读", status: "离线阅读 · 完整题图已载入" }]
  ]);
  const readingMode = document.body.dataset.readingMode;
  const SUBJECT_LABELS = new Map([
    ["高等数学", "高等数学"],
    ["线性代数", "线性代数"],
    ["概率论与数理统计", "概率与统计"],
    ["综合", "综合专题"]
  ]);
  const byId = id => document.getElementById(id);
  const dom = Object.fromEntries([
    "topic-navigation", "search-input", "source-filter", "review-filter", "notes-filter",
    "collection-subject", "collection-title", "collection-description", "collection-stats",
    "reset-filters", "result-count", "entry-grid", "empty-state", "pagination", "page-footer",
    "notice", "toast", "entry-dialog", "detail-title", "detail-tags", "original-title",
    "detail-toolbar", "detail-scroll", "detail-columns", "image-panel", "image-gallery",
    "note-content", "notes-panel", "notes-context", "correction-note", "correction-content", "math-notice", "related-knowledge", "knowledge-list", "knowledge-empty", "detail-source", "detail-path", "original-order",
    "original-content", "previous-entry", "next-entry", "detail-position", "image-dialog",
    "zoom-image", "zoom-image-error", "image-caption", "image-zoom-toggle", "open-original-image", "sidebar-toggle",
    "reading-options", "reading-modes", "reading-status", "online-reading-link", "current-online-mode",
    "offline-download", "current-offline-mode"
  ].map(id => [id, byId(id)]));

  const state = { subject: "", topic: "", source: "", query: "", review: "all", notesOnly: false, page: 1 };
  let data;
  let sourceMap;
  let topicMap;
  let entryMap;
  let searchIndex;
  let filteredEntries = [];
  let currentEntryId = "";
  let reviewRecords = {};
  let storageAvailable = true;
  let searchTimer;
  let toastTimer;
  let originalRendered = false;
  const notices = new Set();

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function normalize(value) {
    return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
  }

  function showNotice(message) {
    notices.add(message);
    dom.notice.textContent = [...notices].join(" ");
    dom.notice.hidden = false;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 2300);
  }

  function validateData(candidate) {
    if (!candidate || candidate.schemaVersion !== DATA_SCHEMA_VERSION) throw new Error("笔记数据未载入，或数据版本不受支持。请将新版网页与数据文件放在一起。");
    if (!Array.isArray(candidate.entries) || !Array.isArray(candidate.topics) || !Array.isArray(candidate.sources)) throw new Error("笔记数据缺少题目、专题或来源目录。");
    if (!candidate.stats || ["entryCount", "sourceCount", "imageCount", "missingImages"].some(key => !Number.isFinite(candidate.stats[key]) || candidate.stats[key] < 0)) throw new Error("笔记数据的统计信息不完整。");
    if (candidate.sourceLinksAvailable !== undefined && typeof candidate.sourceLinksAvailable !== "boolean") throw new Error("原笔记链接配置必须为布尔值。");
    if (candidate.topics.some(topic => !topic.id || typeof topic.label !== "string" || typeof topic.subject !== "string")) throw new Error("专题目录格式错误。");
    if (candidate.sources.some(source => !source.id || typeof source.title !== "string" || typeof source.path !== "string" || !Number.isFinite(source.entryCount))) throw new Error("来源目录格式错误。");
    const topics = new Set(candidate.topics.map(topic => topic.id));
    const sources = new Set(candidate.sources.map(source => source.id));
    const ids = new Set();
    for (const entry of candidate.entries) {
      if (!entry.id || ids.has(entry.id)) throw new Error(`笔记编号缺失或重复：${entry.id}`);
      ids.add(entry.id);
      if (!topics.has(entry.topicId) || !sources.has(entry.sourceId)) throw new Error(`笔记的专题或来源不存在：${entry.id}`);
      if (!Array.isArray(entry.relatedTopicIds) || entry.relatedTopicIds.some(id => !topics.has(id))) throw new Error(`笔记的相关专题无效：${entry.id}`);
      if (!Array.isArray(entry.relatedKnowledge) || entry.relatedKnowledge.some(reference => !reference || typeof reference.entryId !== "string" || !["context", "direct", "foundation"].includes(reference.relation) || !Array.isArray(reference.sharedTerms) || reference.sharedTerms.some(term => typeof term !== "string"))) throw new Error(`笔记的知识关联格式错误：${entry.id}`);
      if (!Array.isArray(entry.images) || !Array.isArray(entry.trail) || typeof entry.title !== "string" || typeof entry.notesHtml !== "string" || typeof entry.searchText !== "string" || typeof entry.hasNotes !== "boolean" || !Number.isInteger(entry.line) || entry.line < 1) throw new Error(`笔记内容结构不完整：${entry.id}`);
      if (entry.images.some(image => !["ok", "missing"].includes(image.status) || (image.status === "ok" && (typeof image.src !== "string" || !image.src)))) throw new Error(`笔记图片记录不完整：${entry.id}`);
    }
    for (const entry of candidate.entries) {
      const referencedIds = new Set();
      for (const reference of entry.relatedKnowledge) {
        if (reference.entryId === entry.id || !ids.has(reference.entryId) || referencedIds.has(reference.entryId)) throw new Error(`笔记的知识关联缺失、自引用或重复：${entry.id} → ${reference.entryId}`);
        referencedIds.add(reference.entryId);
      }
    }
    return candidate;
  }

  function readReviewRecords() {
    try {
      const saved = localStorage.getItem(REVIEW_STORAGE_KEY);
      if (saved === null) return;
      const parsed = JSON.parse(saved);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("复习记录格式错误");
      for (const record of Object.values(parsed)) {
        if (!record || typeof record !== "object" || typeof record.favorite !== "boolean" || typeof record.mastered !== "boolean") throw new Error("复习记录字段不完整");
      }
      reviewRecords = parsed;
    } catch (error) {
      storageAvailable = false;
      showNotice(`复习记录读取失败：${error.message}。收藏和掌握标记已停用，原有记录未被覆盖。`);
    }
  }

  function reviewFor(id) {
    return Object.hasOwn(reviewRecords, id) ? reviewRecords[id] : { favorite: false, mastered: false };
  }

  function saveReview(id, field) {
    if (!storageAvailable) return;
    const previous = reviewFor(id);
    const next = { ...reviewRecords, [id]: { ...previous, [field]: !previous[field] } };
    try {
      localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      storageAvailable = false;
      showNotice(`复习记录保存失败：${error.message}。本次标记未保存，收藏和掌握标记已停用。`);
      renderCards();
      renderDetailToolbar(entryMap.get(currentEntryId));
      return;
    }
    reviewRecords = next;
    showToast(field === "favorite" ? (next[id].favorite ? "已收藏" : "已取消收藏") : (next[id].mastered ? "已标记为掌握" : "已放回待复习"));
    updateResults();
    if (currentEntryId) renderDetailToolbar(entryMap.get(currentEntryId));
  }

  function topicsFor(entry) {
    return [entry.topicId, ...entry.relatedTopicIds];
  }

  function makeSearchIndex() {
    return new Map(data.entries.map(entry => {
      const source = sourceMap.get(entry.sourceId);
      const text = [entry.title, entry.originalTitle, entry.searchText, ...entry.trail, source.title, source.path, ...topicsFor(entry).map(id => topicMap.get(id).label)].filter(value => typeof value === "string").join(" ");
      return [entry.id, normalize(text)];
    }));
  }

  function renderNavigation() {
    const counts = new Map(data.topics.map(topic => [topic.id, 0]));
    for (const entry of data.entries) for (const id of new Set(topicsFor(entry))) counts.set(id, counts.get(id) + 1);
    const subjects = [...new Set(data.topics.map(topic => topic.subject))];
    dom["topic-navigation"].innerHTML = `<button class="nav-all${!state.topic && !state.subject ? " active" : ""}" type="button" data-nav="all"><span>全部题目与笔记</span><span class="nav-count">${data.entries.length.toLocaleString("zh-CN")}</span></button>` + subjects.map(subject => {
      const subjectEntries = data.entries.filter(entry => topicsFor(entry).some(id => topicMap.get(id).subject === subject)).length;
      const topics = data.topics.filter(topic => topic.subject === subject && counts.get(topic.id) > 0);
      if (!topics.length) return "";
      return `<div class="subject-group"><button class="nav-subject${state.subject === subject && !state.topic ? " active" : ""}" type="button" data-subject="${escapeHtml(subject)}"><span class="subject-marker" aria-hidden="true"></span><span>${escapeHtml(SUBJECT_LABELS.get(subject) || subject)}</span><span class="nav-count">${subjectEntries.toLocaleString("zh-CN")}</span></button><div class="topic-list">${topics.map(topic => `<button class="nav-topic${state.topic === topic.id ? " active" : ""}" type="button" data-topic="${escapeHtml(topic.id)}" title="${escapeHtml(topic.label)}"><span>${escapeHtml(topic.label)}</span><span class="nav-count">${counts.get(topic.id).toLocaleString("zh-CN")}</span></button>`).join("")}</div></div>`;
    }).join("");
    for (const button of dom["topic-navigation"].querySelectorAll("button")) button.setAttribute("aria-current", button.classList.contains("active") ? "page" : "false");
  }

  function renderSources() {
    dom["source-filter"].innerHTML = `<option value="">全部来源（${data.sources.length}）</option>` + data.sources.map(source => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.title)} · ${source.entryCount}</option>`).join("");
  }

  function renderHeading() {
    const topic = state.topic ? topicMap.get(state.topic) : null;
    dom["collection-subject"].textContent = topic ? topic.subject : (state.subject || "数学复习");
    dom["collection-title"].textContent = topic ? topic.label : (state.subject ? SUBJECT_LABELS.get(state.subject) || state.subject : "全部题目与笔记");
    dom["collection-description"].textContent = topic ? "集中回看这一专题的题目、解法与易错提醒。" : "沿着专题回看题目，把解法和容易出错的细节放在一起。";
    dom["collection-stats"].innerHTML = [
      [data.stats.entryCount, "条题目与笔记"],
      [data.stats.sourceCount, "篇来源笔记"],
      [data.stats.imageCount, "张原图"]
    ].map(([count, label]) => `<div class="stat"><strong>${count.toLocaleString("zh-CN")}</strong><span>${label}</span></div>`).join("");
  }

  function matchesFilters(entry, tokens) {
    const entryTopics = topicsFor(entry);
    if (state.topic && !entryTopics.includes(state.topic)) return false;
    if (state.subject && !entryTopics.some(id => topicMap.get(id).subject === state.subject)) return false;
    if (state.source && entry.sourceId !== state.source) return false;
    if (state.notesOnly && !entry.hasNotes) return false;
    const review = reviewFor(entry.id);
    if (state.review === "favorites" && !review.favorite) return false;
    if (state.review === "pending" && review.mastered) return false;
    if (state.review === "mastered" && !review.mastered) return false;
    const text = searchIndex.get(entry.id);
    return tokens.every(token => text.includes(token));
  }

  function updateResults() {
    const tokens = normalize(state.query).split(" ").filter(Boolean);
    filteredEntries = data.entries.filter(entry => matchesFilters(entry, tokens));
    state.page = Math.min(state.page, Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE)));
    const active = Boolean(state.subject || state.topic || state.source || state.query || state.notesOnly || state.review !== "all");
    dom["reset-filters"].hidden = !active;
    dom["result-count"].innerHTML = `共 <span class="result-number">${filteredEntries.length.toLocaleString("zh-CN")}</span> 条${active ? "匹配记录" : "题目与笔记"}`;
    dom["empty-state"].hidden = filteredEntries.length > 0;
    renderHeading();
    renderCards();
    renderPagination();
    if (currentEntryId) renderDetailPosition();
  }

  function previewText(entry) {
    const temp = document.createElement("div");
    temp.innerHTML = entry.notesHtml;
    for (const ref of temp.querySelectorAll(".image-ref")) ref.remove();
    return temp.textContent.replace(/\s+/g, " ").trim();
  }

  function cardHtml(entry) {
    const source = sourceMap.get(entry.sourceId);
    const topic = topicMap.get(entry.topicId);
    const review = reviewFor(entry.id);
    const preview = previewText(entry);
    const sourceLabel = entry.trail.length ? `${source.title} / ${entry.trail.join(" / ")}` : source.title;
    const meta = [];
    if (entry.images.length) meta.push(`${entry.images.length} 张原图`);
    if (entry.hasNotes) meta.push("含文字笔记");
    if (entry.relatedKnowledge.length) meta.push(`关联 ${entry.relatedKnowledge.length} 条知识`);
    return `<article class="entry-card"><button class="card-open" type="button" data-open="${escapeHtml(entry.id)}" aria-label="查看：${escapeHtml(entry.title)}"><div class="card-kicker"><span class="topic-tag">${escapeHtml(topic.label)}</span><span class="kind-tag">${entry.kind === "question" ? "题目" : "方法与易错点"}</span></div><h2 class="card-title">${escapeHtml(entry.title)}</h2><p class="card-excerpt">${preview ? escapeHtml(preview.slice(0, 170)) : "查看原图中的题目与解答。"}</p><div class="card-meta">${meta.map(label => `<span>${escapeHtml(label)}</span>`).join("")}</div></button><div class="card-footer"><span class="card-source" title="${escapeHtml(sourceLabel)}">${escapeHtml(sourceLabel)}</span><span class="review-chip${review.mastered ? " mastered" : ""}">${review.mastered ? "已掌握" : "待复习"}</span><button class="favorite-button${review.favorite ? " active" : ""}" type="button" data-favorite="${escapeHtml(entry.id)}" aria-label="${review.favorite ? "取消收藏" : "收藏"}：${escapeHtml(entry.title)}" aria-pressed="${review.favorite}"${storageAvailable ? "" : " disabled"}>${review.favorite ? "★" : "☆"}</button></div></article>`;
  }

  function renderCards() {
    const start = (state.page - 1) * PAGE_SIZE;
    dom["entry-grid"].innerHTML = filteredEntries.slice(start, start + PAGE_SIZE).map(cardHtml).join("");
    renderMath(dom["entry-grid"]);
  }

  function pageNumbers(total) {
    const visible = new Set([1, total, state.page - 1, state.page, state.page + 1]);
    if (state.page <= 3) for (let page = 1; page <= Math.min(4, total); page++) visible.add(page);
    if (state.page >= total - 2) for (let page = Math.max(1, total - 3); page <= total; page++) visible.add(page);
    return [...visible].filter(page => page > 0 && page <= total).sort((a, b) => a - b);
  }

  function renderPagination() {
    const total = Math.ceil(filteredEntries.length / PAGE_SIZE);
    if (total <= 1) { dom.pagination.innerHTML = ""; return; }
    const numbers = pageNumbers(total);
    let previous = 0;
    const middle = numbers.map(page => {
      const gap = previous && page - previous > 1 ? `<span class="page-ellipsis" aria-hidden="true">…</span>` : "";
      previous = page;
      return `${gap}<button class="page-button${page === state.page ? " active" : ""}" type="button" data-page="${page}"${page === state.page ? ' aria-current="page"' : ""} aria-label="第 ${page} 页">${page}</button>`;
    }).join("");
    dom.pagination.innerHTML = `<button class="page-button" type="button" data-page="${state.page - 1}"${state.page === 1 ? " disabled" : ""}>上一页</button>${middle}<button class="page-button" type="button" data-page="${state.page + 1}"${state.page === total ? " disabled" : ""}>下一页</button>`;
  }

  function setFilters(changes) {
    Object.assign(state, changes, { page: 1 });
    renderNavigation();
    updateResults();
  }

  function resetFilters() {
    clearTimeout(searchTimer);
    dom["search-input"].value = "";
    dom["source-filter"].value = "";
    dom["review-filter"].value = "all";
    dom["notes-filter"].checked = false;
    setFilters({ subject: "", topic: "", source: "", query: "", review: "all", notesOnly: false });
  }

  function imageFigure(entry, image, index, compact = false, imagePrefix = `image-${entry.id}`) {
    const number = index + 1;
    const imageId = `${imagePrefix}-${number}`;
    if (image.status !== "ok" || !image.src) return `<figure class="note-figure" id="${escapeHtml(imageId)}"><div class="image-error">图 ${number} 暂缺本地图片。<br>请在原始笔记中查看对应图片。</div><figcaption>图 ${number}</figcaption></figure>`;
    const dimensions = image.width > 0 && image.height > 0 ? ` width="${image.width}" height="${image.height}"` : "";
    return `<figure class="note-figure${compact ? " compact-figure" : ""}" id="${escapeHtml(imageId)}"><button class="image-button" type="button" data-image="${index}" data-image-entry="${escapeHtml(entry.id)}" aria-label="放大图 ${number}"><img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt || `${entry.title}，图 ${number}`)}"${dimensions} loading="lazy" decoding="async"></button><figcaption>图 ${number}</figcaption></figure>`;
  }

  function renderGallery(entry) {
    if (entry.images.length <= 3) {
      dom["image-gallery"].classList.remove("with-more");
      dom["image-gallery"].innerHTML = entry.images.map((image, index) => imageFigure(entry, image, index)).join("");
      return;
    }
    dom["image-gallery"].classList.add("with-more");
    const remaining = entry.images.slice(1).map((image, index) => imageFigure(entry, image, index + 1, true)).join("");
    dom["image-gallery"].innerHTML = `${imageFigure(entry, entry.images[0], 0)}<details class="more-images"><summary>展开其余 ${entry.images.length - 1} 张原图</summary><div class="more-image-grid">${remaining}</div></details>`;
  }

  function sourcePathHtml(entry) {
    const source = sourceMap.get(entry.sourceId);
    const sourceHref = "../" + source.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
    const sourcePath = escapeHtml(source.path.replaceAll("/", "\\"));
    const label = data.sourceLinksAvailable === false ? sourcePath : `<a href="${escapeHtml(sourceHref)}" target="_blank" rel="noopener">${sourcePath}</a>`;
    return `${label} · 第 ${entry.line} 行起`;
  }

  function notesContextHtml(entry) {
    const context = entry.trail.slice(1);
    if (!context.length) return "";
    return `<div class="notes-context"><h4>原笔记章节与条件</h4><p>${escapeHtml(context.join(" › "))}</p></div>`;
  }

  function relatedKnowledgeCard(reference, questionId) {
    const knowledge = entryMap.get(reference.entryId);
    const source = sourceMap.get(knowledge.sourceId);
    const terms = [...new Set(reference.sharedTerms)];
    const termHtml = terms.length ? `<span class="knowledge-terms">相关考点：${terms.map(escapeHtml).join("、")}</span>` : "";
    const imagePrefix = `knowledge-${questionId}-${knowledge.id}`;
    return `<details class="related-knowledge-card" data-knowledge-entry="${escapeHtml(knowledge.id)}" data-image-prefix="${escapeHtml(imagePrefix)}"><summary><span class="knowledge-title">${escapeHtml(knowledge.title)}</span><span class="knowledge-source">${escapeHtml(source.title)} · 第 ${knowledge.line} 行</span>${termHtml}<span class="knowledge-expand"><span class="when-closed">展开笔记</span><span class="when-open">收起笔记</span><span aria-hidden="true">⌄</span></span></summary><div class="knowledge-body"></div></details>`;
  }

  function renderRelatedKnowledge(entry) {
    dom["related-knowledge"].hidden = entry.kind !== "question" && !entry.relatedKnowledge.length;
    dom["knowledge-empty"].hidden = entry.relatedKnowledge.length > 0;
    dom["knowledge-list"].innerHTML = [
      ["context", "原笔记补充说明"],
      ["direct", "相关考点与方法"],
      ["foundation", "本专题基础"]
    ].map(([relation, label]) => {
      const references = entry.relatedKnowledge.filter(reference => reference.relation === relation);
      if (!references.length) return "";
      return `<div class="knowledge-group"><h5>${label}</h5>${references.map(reference => relatedKnowledgeCard(reference, entry.id)).join("")}</div>`;
    }).join("");
  }

  function remapImageReferences(content, entry, imagePrefix) {
    const originalPrefix = `#image-${entry.id}-`;
    for (const reference of content.querySelectorAll("a.image-ref")) {
      const originalHref = reference.getAttribute("href");
      const number = originalHref?.startsWith(originalPrefix) ? Number(originalHref.slice(originalPrefix.length)) : NaN;
      if (!Number.isInteger(number) || number < 1 || number > entry.images.length) {
        showNotice(`知识笔记的图号没有对应图片：${entry.title}。`);
        throw new Error(`知识笔记图片引用无效：${entry.id}`);
      }
      reference.setAttribute("href", `#${imagePrefix}-${number}`);
    }
  }

  function renderKnowledgeBody(card) {
    if (card.dataset.rendered === "true") return;
    const knowledge = entryMap.get(card.dataset.knowledgeEntry);
    if (!knowledge) { showNotice("关联的知识笔记不存在，请检查数据文件是否完整。"); return; }
    const body = card.querySelector(".knowledge-body");
    const correction = typeof knowledge.correctionHtml === "string" && knowledge.correctionHtml.trim();
    const correctionHtml = correction ? `<div class="correction-note"><h4>公式核对</h4><div class="note-content">${knowledge.correctionHtml}</div></div>` : "";
    const imagePrefix = card.dataset.imagePrefix;
    const images = knowledge.images.length ? `<div class="knowledge-image-grid">${knowledge.images.map((image, index) => imageFigure(knowledge, image, index, true, imagePrefix)).join("")}</div>` : "";
    body.innerHTML = `${notesContextHtml(knowledge)}${correctionHtml}<div class="note-content knowledge-note-content">${knowledge.notesHtml}</div><div class="knowledge-math-notice math-notice" role="status" hidden></div>${images}<p class="knowledge-path source-path">${sourcePathHtml(knowledge)}</p>`;
    compactNoteContent(body.querySelector(".knowledge-note-content"), knowledge.title);
    remapImageReferences(body, knowledge, imagePrefix);
    renderMath(body);
    const errors = body.querySelectorAll(".katex-error").length;
    const mathNotice = body.querySelector(".knowledge-math-notice");
    mathNotice.hidden = errors === 0;
    mathNotice.textContent = errors ? `有 ${errors} 处公式无法排版，已保留原式并标红。` : "";
    card.dataset.rendered = "true";
  }

  function renderDetailToolbar(entry) {
    if (!entry) return;
    const review = reviewFor(entry.id);
    dom["detail-toolbar"].innerHTML = `<button class="toolbar-button favorite${review.favorite ? " active" : ""}" type="button" data-favorite="${escapeHtml(entry.id)}" aria-pressed="${review.favorite}"${storageAvailable ? "" : " disabled"}><span aria-hidden="true">${review.favorite ? "★" : "☆"}</span>${review.favorite ? "已收藏" : "收藏这条"}</button><button class="toolbar-button${review.mastered ? " active" : ""}" type="button" data-mastered="${escapeHtml(entry.id)}" aria-pressed="${review.mastered}"${storageAvailable ? "" : " disabled"}><span aria-hidden="true">${review.mastered ? "✓" : "○"}</span>${review.mastered ? "已掌握" : "标记已掌握"}</button><span class="detail-image-count">${entry.images.length} 张原图 · ${entry.hasNotes ? "含文字笔记" : "图片记录"}</span>`;
  }

  function renderDetailPosition() {
    const index = filteredEntries.findIndex(entry => entry.id === currentEntryId);
    dom["previous-entry"].disabled = index <= 0;
    dom["next-entry"].disabled = index < 0 || index >= filteredEntries.length - 1;
    dom["detail-position"].textContent = index < 0 ? "此条已不在当前筛选结果中" : `${index + 1} / ${filteredEntries.length}`;
  }

  function displayTitle(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function isImageReferenceParagraph(element) {
    if (!element?.matches("p") || !element.querySelector("a.image-ref")) return false;
    return [...element.childNodes].every(node =>
      (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) ||
      (node.nodeType === Node.ELEMENT_NODE && node.matches("a.image-ref, br"))
    );
  }

  function nextImageReferenceParagraph(paragraph) {
    let sibling = paragraph.nextSibling;
    while (sibling?.nodeType === Node.TEXT_NODE && !sibling.textContent.trim()) sibling = sibling.nextSibling;
    return sibling?.nodeType === Node.ELEMENT_NODE && isImageReferenceParagraph(sibling) ? sibling : null;
  }

  function compactNoteContent(content, title) {
    const first = content.firstElementChild;
    const heading = first && /^H[1-6]$/.test(first.tagName) ? first.textContent : "";
    // 窗口或知识卡已完整显示的标题，不在正文重复占一行。
    if (heading && displayTitle(heading) === displayTitle(title)) first.remove();
    for (const paragraph of content.querySelectorAll("p")) {
      if (!content.contains(paragraph) || !isImageReferenceParagraph(paragraph)) continue;
      paragraph.classList.add("image-reference-row");
      paragraph.replaceChildren(...paragraph.querySelectorAll("a.image-ref"));
      let next = nextImageReferenceParagraph(paragraph);
      while (next) {
        paragraph.append(...next.querySelectorAll("a.image-ref"));
        next.remove();
        next = nextImageReferenceParagraph(paragraph);
      }
    }
    return heading;
  }

  function openEntry(id) {
    const entry = entryMap.get(id);
    if (!entry) { showNotice(`找不到编号为 ${id} 的笔记。`); return; }
    currentEntryId = id;
    originalRendered = false;
    const source = sourceMap.get(entry.sourceId);
    dom["detail-title"].textContent = entry.title;
    dom["detail-tags"].innerHTML = topicsFor(entry).map(topicId => `<span class="topic-tag">${escapeHtml(topicMap.get(topicId).label)}</span>`).join("");
    dom["image-panel"].hidden = !entry.images.length;
    dom["detail-columns"].classList.toggle("no-images", !entry.images.length);
    renderGallery(entry);
    const context = notesContextHtml(entry);
    dom["notes-context"].hidden = !context;
    dom["notes-context"].innerHTML = context;
    dom["note-content"].innerHTML = entry.notesHtml.trim() ? entry.notesHtml : '<p class="no-notes">这条记录没有附带文字解法，可查看题图与解答原图。</p>';
    const sourceHeading = compactNoteContent(dom["note-content"], entry.title);
    const showOriginalTitle = Boolean(entry.originalTitle && displayTitle(entry.originalTitle) !== displayTitle(entry.title) && displayTitle(entry.originalTitle) !== displayTitle(sourceHeading));
    dom["original-title"].hidden = !showOriginalTitle;
    dom["original-title"].textContent = showOriginalTitle ? `原记录：${entry.originalTitle}` : "";
    const correction = typeof entry.correctionHtml === "string" && entry.correctionHtml.trim();
    dom["correction-note"].hidden = !correction;
    dom["correction-content"].innerHTML = correction ? entry.correctionHtml : "";
    renderRelatedKnowledge(entry);
    dom["original-order"].hidden = !entry.images.length || typeof entry.html !== "string" || !entry.html.trim();
    dom["original-order"].open = false;
    dom["original-content"].innerHTML = "";
    dom["detail-source"].textContent = [source.title, ...entry.trail].join(" › ");
    dom["detail-path"].innerHTML = sourcePathHtml(entry);
    renderDetailToolbar(entry);
    renderDetailPosition();
    if (!dom["entry-dialog"].open) dom["entry-dialog"].showModal();
    syncModalState();
    renderMath(dom["detail-title"].parentElement);
    renderMath(dom["notes-panel"]);
    const errors = dom["notes-panel"].querySelectorAll(".katex-error").length;
    dom["math-notice"].hidden = errors === 0;
    dom["math-notice"].textContent = errors ? `有 ${errors} 处公式无法排版，已保留原式并标红。` : "";
    for (const panel of [dom["detail-scroll"], dom["image-panel"], dom["notes-panel"]]) panel.scrollTop = 0;
  }

  function moveEntry(offset) {
    const index = filteredEntries.findIndex(entry => entry.id === currentEntryId);
    const next = filteredEntries[index + offset];
    if (next) openEntry(next.id);
  }

  function openImage(entryId, index) {
    const entry = entryMap.get(entryId);
    if (!entry) { showNotice("这张图片所属的笔记不存在。"); return; }
    const image = entry.images[index];
    if (!image || image.status !== "ok" || !image.src) { showNotice("这张图片暂不可用，请检查本地图片文件。"); return; }
    dom["zoom-image-error"].hidden = true;
    dom["zoom-image"].hidden = false;
    dom["zoom-image"].src = image.src;
    dom["zoom-image"].alt = image.alt || `${entry.title}，图 ${index + 1}`;
    dom["image-caption"].textContent = `${entry.title} · 图 ${index + 1} / ${entry.images.length}`;
    dom["open-original-image"].href = image.src;
    setImageZoom(false);
    if (!dom["image-dialog"].open) dom["image-dialog"].showModal();
    renderMath(dom["image-caption"]);
    syncModalState();
  }

  function setImageZoom(enlarged) {
    dom["zoom-image"].classList.toggle("natural-size", enlarged);
    dom["image-zoom-toggle"].setAttribute("aria-pressed", String(enlarged));
    dom["image-zoom-toggle"].textContent = enlarged ? "适合屏幕" : "放大";
    dom["zoom-image"].parentElement.scrollTo({ top: 0, left: 0 });
  }

  function syncModalState() {
    document.body.classList.toggle("modal-open", DIALOG_IDS.some(id => dom[id].open));
  }

  function renderReadingMode() {
    const mode = READING_MODES.get(readingMode);
    if (!mode) throw new Error("阅读方式配置无效，请使用完整的新版阅读器。");
    dom["reading-options"].textContent = mode.label;
    dom["reading-status"].textContent = mode.status;
    dom["online-reading-link"].hidden = readingMode === "online";
    dom["current-online-mode"].hidden = readingMode !== "online";
    dom["offline-download"].hidden = readingMode === "offline";
    dom["current-offline-mode"].hidden = readingMode !== "offline";
  }

  function renderMath(element) {
    if (typeof window.renderMathInElement !== "function") {
      showNotice("公式排版组件未载入。请确认 vendor 文件夹与网页放在一起；公式当前显示为原始写法。");
      return;
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
      trust: false,
      strict: "warn"
    });
  }

  function handleImageError(image) {
    const button = image.closest(".image-button");
    const caption = button ? button.closest("figure").querySelector("figcaption").textContent : "原图";
    const message = readingMode === "online"
      ? `${caption} 加载失败，请检查网络后重新打开这条题目。`
      : `${caption} 加载失败，请检查本地图片文件是否完整。`;
    if (image === dom["zoom-image"]) {
      dom["zoom-image-error"].textContent = message;
      dom["zoom-image-error"].hidden = false;
      image.hidden = true;
      return;
    }
    const error = document.createElement("div");
    error.className = "image-error";
    error.setAttribute("role", "alert");
    error.textContent = message;
    if (button) button.replaceWith(error);
    else image.replaceWith(error);
  }

  function handleNotebookClick(event) {
    const image = event.target.closest("[data-image][data-image-entry]");
    if (image) { openImage(image.dataset.imageEntry, Number(image.dataset.image)); return; }
    const reference = event.target.closest("a.image-ref");
    if (!reference) return;
    event.preventDefault();
    const target = document.getElementById(reference.getAttribute("href").slice(1));
    if (!target) { showNotice("这条图片引用没有对应的原图编号。"); return; }
    for (let group = target.parentElement; group; group = group.parentElement) {
      if (group instanceof HTMLDetailsElement) group.open = true;
    }
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("highlight");
    setTimeout(() => target.classList.remove("highlight"), 1800);
  }

  function closeSidebar() {
    document.body.classList.remove("sidebar-open");
    dom["sidebar-toggle"].setAttribute("aria-expanded", "false");
    dom["sidebar-toggle"].setAttribute("aria-label", "打开专题导航");
  }

  function bindEvents() {
    dom["topic-navigation"].addEventListener("click", event => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.nav === "all") setFilters({ subject: "", topic: "" });
      if (button.dataset.subject) setFilters({ subject: button.dataset.subject, topic: "" });
      if (button.dataset.topic) setFilters({ subject: "", topic: button.dataset.topic });
      closeSidebar();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    dom["search-input"].addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => setFilters({ query: dom["search-input"].value }), SEARCH_DELAY_MS);
    });
    dom["source-filter"].addEventListener("change", () => setFilters({ source: dom["source-filter"].value }));
    dom["review-filter"].addEventListener("change", () => setFilters({ review: dom["review-filter"].value }));
    dom["notes-filter"].addEventListener("change", () => setFilters({ notesOnly: dom["notes-filter"].checked }));
    dom["reset-filters"].addEventListener("click", resetFilters);
    byId("empty-reset").addEventListener("click", resetFilters);
    dom["entry-grid"].addEventListener("click", event => {
      const open = event.target.closest("[data-open]");
      const favorite = event.target.closest("[data-favorite]");
      if (open) openEntry(open.dataset.open);
      if (favorite) saveReview(favorite.dataset.favorite, "favorite");
    });
    dom.pagination.addEventListener("click", event => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.page);
      renderCards();
      renderPagination();
      dom["result-count"].scrollIntoView({ behavior: "smooth", block: "start" });
    });
    dom["detail-toolbar"].addEventListener("click", event => {
      const favorite = event.target.closest("[data-favorite]");
      const mastered = event.target.closest("[data-mastered]");
      if (favorite) saveReview(favorite.dataset.favorite, "favorite");
      if (mastered) saveReview(mastered.dataset.mastered, "mastered");
    });
    dom["detail-columns"].addEventListener("click", handleNotebookClick);
    dom["detail-columns"].addEventListener("error", event => { if (event.target instanceof HTMLImageElement) handleImageError(event.target); }, true);
    dom["zoom-image"].addEventListener("error", event => handleImageError(event.target));
    dom["related-knowledge"].addEventListener("toggle", event => {
      const card = event.target;
      if (!(card instanceof HTMLDetailsElement) || !card.dataset.knowledgeEntry || !card.open || !dom["related-knowledge"].contains(card)) return;
      renderKnowledgeBody(card);
    }, true);
    dom["original-order"].addEventListener("toggle", () => {
      if (!dom["original-order"].open || originalRendered) return;
      dom["original-content"].innerHTML = entryMap.get(currentEntryId).html;
      renderMath(dom["original-content"]);
      originalRendered = true;
    });
    dom["previous-entry"].addEventListener("click", () => moveEntry(-1));
    dom["next-entry"].addEventListener("click", () => moveEntry(1));
    byId("close-entry").addEventListener("click", () => dom["entry-dialog"].close());
    byId("close-image").addEventListener("click", () => dom["image-dialog"].close());
    dom["image-zoom-toggle"].addEventListener("click", () => setImageZoom(!dom["zoom-image"].classList.contains("natural-size")));
    dom["reading-options"].addEventListener("click", () => {
      closeSidebar();
      dom["reading-modes"].showModal();
      syncModalState();
    });
    for (const dialog of DIALOG_IDS.map(id => dom[id])) {
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
      dialog.addEventListener("close", () => { if (dialog === dom["entry-dialog"]) currentEntryId = ""; syncModalState(); });
    }
    dom["sidebar-toggle"].addEventListener("click", () => {
      const open = document.body.classList.toggle("sidebar-open");
      dom["sidebar-toggle"].setAttribute("aria-expanded", String(open));
      dom["sidebar-toggle"].setAttribute("aria-label", open ? "关闭专题导航" : "打开专题导航");
    });
    byId("sidebar-shade").addEventListener("click", closeSidebar);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeSidebar();
      const editing = event.target instanceof HTMLElement && (event.target.matches("input,textarea,select") || event.target.isContentEditable);
      if (event.key === "/" && !editing && !DIALOG_IDS.some(id => dom[id].open)) { event.preventDefault(); dom["search-input"].focus(); }
      if (!editing && dom["entry-dialog"].open && !dom["image-dialog"].open) {
        if (event.key === "ArrowLeft") moveEntry(-1);
        if (event.key === "ArrowRight") moveEntry(1);
      }
    });
  }

  function initialize() {
    try {
      data = validateData(window.MATH_NOTEBOOK);
      renderReadingMode();
      sourceMap = new Map(data.sources.map(source => [source.id, source]));
      topicMap = new Map(data.topics.map(topic => [topic.id, topic]));
      entryMap = new Map(data.entries.map(entry => [entry.id, entry]));
      searchIndex = makeSearchIndex();
      readReviewRecords();
      renderNavigation();
      renderSources();
      bindEvents();
      updateResults();
      dom["page-footer"].textContent = `收藏与掌握记录保存在当前浏览器中。${data.stats.missingImages > 0 ? `有 ${data.stats.missingImages} 张原图尚未保存在本地。` : ""}`;
    } catch (error) {
      dom["result-count"].textContent = "笔记读取失败";
      showNotice(error.message);
      console.error(error);
    }
  }

  initialize();
})();
