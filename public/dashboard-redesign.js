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

    if (!name || /all/i.test(name)) return "Coaches";

    return name.replace(/coach/gi, "").trim() || "Coach";
  }

  function formatToday() {
    return new Intl.DateTimeFormat("en-AU", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date());
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

  function addPageIntro() {
    const content = qs("#content");
    const anchor = qs("#dash-week-nav");

    if (!content || !anchor || qs(".dp-page-intro")) return;

    const intro = document.createElement("section");
    intro.className = "dp-page-intro";
    intro.innerHTML = `
      <div>
        <div class="dp-eyebrow">Coach overview</div>

        <h1 class="dp-page-title">
          Good morning,
          <span id="dp-intro-coach">${coachName()}</span>
        </h1>

        <p class="dp-page-subtitle">
          Start with the athletes who need a decision, then review squad
          adherence and recent activity.
        </p>
      </div>

      <div class="dp-intro-date">${formatToday()}</div>
    `;

    content.insertBefore(intro, anchor);
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

    qsa(".sf").forEach((button) => {
      const status = button.dataset.status;

      if (status === "red") {
        replaceFirstTextNode(button, "Critical", ["alert"]);
      }

      if (status === "amber") {
        replaceFirstTextNode(button, "Review", ["watch"]);
      }

      if (status === "green") {
        replaceFirstTextNode(button, "On track", ["on track"]);
      }
    });

    const commandTitle = qs(".cc-title");

    if (
      commandTitle &&
      /command centre/i.test(commandTitle.textContent)
    ) {
      commandTitle.textContent = "Priority actions";
    }

    const commandKicker = qs(".cc-kicker");

    if (
      commandKicker &&
      commandKicker.textContent !== "What needs attention now"
    ) {
      commandKicker.textContent = "What needs attention now";
    }

    const briefTitle = qs(".sb-title");

    if (briefTitle && briefTitle.textContent !== "Squad brief") {
      briefTitle.textContent = "Squad brief";
    }
  }

  function updateGreeting() {
    const greeting = qs("#dp-intro-coach");

    if (greeting) {
      greeting.textContent = coachName();
    }
  }

  function enhance() {
    try {
      addPageIntro();
      improveLabels();
      updateGreeting();
    } catch (error) {
      console.error("[DP dashboard redesign]", error);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    enhance();

    qs(".coach-select")?.addEventListener("change", updateGreeting);

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
  });
})();
