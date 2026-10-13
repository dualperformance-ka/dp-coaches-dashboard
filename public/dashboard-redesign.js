/* Dual Performance Coaches Dashboard — safe UI enhancements */
(() => {
  "use strict";

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];

  function coachName() {
    const select = qs(".coach-select");
    const name = select?.selectedOptions?.[0]?.textContent?.trim();

    if (!name || /all|select/i.test(name)) return "Coaches";

    const cleaned = name
      .replace(/coach/gi, "")
      .replace(/[^a-z\s'-]/gi, "")
      .trim();

    // Sentence case: the select holds "KARL"; a greeting should say "Karl".
    return cleaned
      ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase()
      : "Coach";
  }

  function formatToday() {
    return new Intl.DateTimeFormat("en-AU", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date());
  }

  function timeGreeting(date = new Date()) {
    const hour = date.getHours();

    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  }

  function replaceFirstTextNode(element, newText, validLabels = []) {
    if (!element?.childNodes?.length) return;

    const node = element.childNodes[0];
    const current = node.textContent.trim().toLowerCase();

    if (
      validLabels.includes(current) &&
      node.textContent !== `${newText} `
    ) {
      node.textContent = `${newText} `;
    }
  }

  // The large greeting hero that used to be injected above Today pushed the
  // decision queue below the fold on a phone. The compact header is static
  // markup in index.html now; this only keeps its words current.
  function hydrateTodayHeader() {
    const content = qs("#tab-triage-content");
    if (!content) return;
    const date = qs("#today-date", content);
    if (date) date.textContent = formatToday();
  }

  function improveLabels() {
    qsa(".tab").forEach((tab) => {
      replaceFirstTextNode(tab, "Overview", ["dashboard", "athletes"]);
      replaceFirstTextNode(tab, "Programming", ["planning"]);
      replaceFirstTextNode(tab, "Applications", ["new"]);
    });

    const search = qs("#search-input");

    if (search) {
      search.placeholder = "Search athletes by name…";
    }

    const commandTitle = qs(".cc-title");

    if (
      commandTitle &&
      /command centre/i.test(commandTitle.textContent)
    ) {
      commandTitle.textContent = "Priority actions";
    }

    const briefTitle = qs(".sb-title");

    if (briefTitle && briefTitle.textContent !== "Squad brief") {
      briefTitle.textContent = "Squad brief";
    }
  }

  function updateGreeting() {
    const salutation = qs("#dp-intro-greeting");
    const coach = qs("#dp-intro-coach");

    if (salutation) salutation.textContent = timeGreeting();
    if (coach) coach.textContent = coachName();
    hydrateTodayHeader();
  }

  function enhance() {
    try {
      hydrateTodayHeader();
      improveLabels();
      updateGreeting();
    } catch (error) {
      console.error("[DP dashboard redesign]", error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    enhance();

    qs(".coach-select")?.addEventListener("change", updateGreeting);
    window.addEventListener("focus", updateGreeting);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) updateGreeting();
    });

    /*
     * The original dashboard renders asynchronously.
     * Run a limited number of safe enhancement passes, then stop.
     */
    let passes = 0;

    const timer = window.setInterval(() => {
      enhance();
      passes += 1;

      if (passes >= 15 || qs("#grid")?.children.length) {
        window.clearInterval(timer);
      }
    }, 500);

    // Keep a long-running dashboard session accurate as the day changes.
    window.setInterval(updateGreeting, 60 * 1000);
  });
})();
