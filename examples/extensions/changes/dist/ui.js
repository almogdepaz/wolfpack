// examples/extensions/changes/src/ui.ts
var STATUS = {
  added: ["A", "Added"],
  modified: ["M", "Modified"],
  deleted: ["D", "Deleted"],
  renamed: ["R", "Renamed"],
  copied: ["C", "Copied"],
  "type-changed": ["T", "Type changed"],
  unmerged: ["!", "Unmerged"],
  untracked: ["U", "Untracked"]
};
function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function text(node, value) {
  if (node.textContent !== value)
    node.textContent = value;
}
function icon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", kind === "refresh" ? "M13 7a5 5 0 1 0-1 4M13 3v4H9" : "M4 5v6m8-6v1a4 4 0 0 1-4 4H4M6 3a2 2 0 1 1-4 0 2 2 0 1 1 4 0M14 3a2 2 0 1 1-4 0 2 2 0 1 1 4 0M6 13a2 2 0 1 1-4 0 2 2 0 1 1 4 0");
  svg.append(path);
  return svg;
}
function fileRow(change) {
  const row = element("li"), path = element("span", "path"), kind = element("span", "kind");
  const [letter, label] = STATUS[change.status];
  const fullPath = change.previousPath ? `${change.previousPath} → ${change.path}` : change.path;
  row.dataset.status = change.status;
  row.setAttribute("aria-label", `${label}: ${fullPath}`);
  path.title = fullPath;
  const directory = change.path.endsWith("/"), trimmed = directory ? change.path.slice(0, -1) : change.path;
  const split = trimmed.lastIndexOf("/");
  path.append(element("span", "file-name", trimmed.slice(split + 1) + (directory ? "/" : "")));
  if (split >= 0)
    path.append(element("span", "directory", trimmed.slice(0, split)));
  if (change.previousPath)
    path.append(element("span", "previous-path", `from ${change.previousPath}`));
  kind.textContent = letter;
  kind.title = label;
  kind.setAttribute("role", "img");
  kind.setAttribute("aria-label", label);
  row.append(path, kind);
  return row;
}
function register(host) {
  host.registerContextView({
    id: "changes",
    title: "Changes",
    mount(container, context) {
      const root = element("section", "wolfpack-changes");
      root.setAttribute("aria-label", "Git changes");
      const style = element("style");
      style.textContent = `
.wolfpack-changes{display:flex;flex-direction:column;gap:10px;min-width:0;height:100%;color:var(--text-primary,#dce5df);font:13px/1.5 system-ui}
.wolfpack-changes [hidden]{display:none!important}
.wolfpack-changes header,.wolfpack-changes .branch-heading,.wolfpack-changes .summary-line,.wolfpack-changes footer{display:flex;align-items:center;gap:8px;min-width:0}
.wolfpack-changes header,.wolfpack-changes .summary-line,.wolfpack-changes footer{justify-content:space-between;flex:none}
.wolfpack-changes header{padding:0;min-height:0;background:none;border:0;box-shadow:none;position:static;z-index:auto;transition:none}
.wolfpack-changes .branch-heading{overflow:hidden}
.wolfpack-changes svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.wolfpack-changes .branch-heading svg{color:var(--text-muted,#a4b2a9)}
.wolfpack-changes .branch{font:600 12px/1.5 monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wolfpack-changes .refresh{display:grid;place-items:center;flex:none;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--text-muted,#a4b2a9);cursor:pointer}
.wolfpack-changes .refresh:hover{background:var(--bg-hover,#1b231e);color:var(--text-primary,#dce5df);border-color:var(--border,#28312b)}
.wolfpack-changes .refresh:focus-visible,.wolfpack-changes summary:focus-visible{outline:2px solid var(--accent,#45ed7e);outline-offset:-2px}
.wolfpack-changes .refresh[aria-busy=true] svg{animation:wolfpack-changes-refresh 1s linear infinite}
@keyframes wolfpack-changes-refresh{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.wolfpack-changes .refresh[aria-busy=true] svg{animation:none}}
.wolfpack-changes .change-count{font-size:12px;font-weight:600}
.wolfpack-changes .read-only{font-size:10px;white-space:nowrap;padding:1px 6px;border:1px solid var(--border,#28312b);border-radius:4px;color:var(--text-muted,#a4b2a9)}
.wolfpack-changes .files{overflow:auto;min-height:0;flex:1;scrollbar-gutter:stable}
.wolfpack-changes details{margin:0 0 8px}
.wolfpack-changes summary{display:flex;align-items:center;gap:8px;min-height:32px;padding:0 6px;list-style:none;cursor:pointer;border-radius:4px;background:var(--bg-inset,#0d100e);font-size:11px;font-weight:600}
.wolfpack-changes summary::-webkit-details-marker{display:none}
.wolfpack-changes summary::before{content:"";width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);margin-right:3px}
.wolfpack-changes details[open]>summary::before{transform:rotate(45deg)}
.wolfpack-changes .group-count{margin-left:auto;min-width:18px;text-align:center;border-radius:9px;background:var(--bg-elevated,#1c211e);color:var(--text-muted,#a4b2a9);font:11px/18px monospace}
.wolfpack-changes ul{list-style:none;margin:3px 0 0;padding:0}
.wolfpack-changes li{display:flex;gap:10px;align-items:center;min-height:32px;padding:5px 7px;border-radius:4px}
.wolfpack-changes li:hover{background:var(--bg-hover,#1b231e)}
.wolfpack-changes .path{min-width:0;flex:1;font:12px/1.5 monospace;unicode-bidi:plaintext}
.wolfpack-changes .file-name,.wolfpack-changes .directory,.wolfpack-changes .previous-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wolfpack-changes .directory,.wolfpack-changes .previous-path{font-size:10px;color:var(--text-muted,#a4b2a9)}
.wolfpack-changes [data-status=deleted] .file-name{text-decoration:line-through}
.wolfpack-changes .kind{flex:none;width:20px;text-align:center;border-radius:3px;background:color-mix(in srgb,currentColor 8%,transparent);font:600 11px/20px monospace;color:#9dc9f4}
.wolfpack-changes [data-status=modified] .kind,.wolfpack-changes [data-status=type-changed] .kind{color:#f1c576}
.wolfpack-changes [data-status=added] .kind,.wolfpack-changes [data-status=untracked] .kind{color:#7fe5a6}
.wolfpack-changes [data-status=deleted] .kind,.wolfpack-changes [data-status=unmerged] .kind{color:#f49898}
.wolfpack-changes .notice{border:1px solid var(--border,#28312b);border-radius:6px;padding:10px;font-size:12px;color:var(--text-muted,#a4b2a9)}
.wolfpack-changes .notice p{margin:0}
.wolfpack-changes .notice[data-kind=empty]{padding:24px 10px;text-align:center}
.wolfpack-changes .notice-symbol{display:block;margin-bottom:6px;font-size:22px}
.wolfpack-changes .notice[data-kind=warning]{border-color:#796134;color:#f1c576}
.wolfpack-changes footer{flex-wrap:wrap;border-top:1px solid var(--border,#28312b);padding-top:8px;color:var(--text-muted,#a4b2a9);font-size:10px}
.wolfpack-changes .auto-refresh{display:flex;align-items:center;gap:5px}
.wolfpack-changes .auto-refresh::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent,#45ed7e)}
.wolfpack-changes[data-stale=true] .auto-refresh::before{background:#f1c576}
@media(pointer:coarse),(max-width:600px){.wolfpack-changes .refresh{width:44px;height:44px}.wolfpack-changes summary{min-height:44px}}
`;
      const header = element("header"), branchHeading = element("div", "branch-heading"), branch = element("span", "branch", "Git"), refresh = element("button", "refresh");
      refresh.type = "button";
      refresh.title = "Refresh Git status";
      refresh.setAttribute("aria-label", "Refresh Git status");
      refresh.append(icon("refresh"));
      branchHeading.append(icon("branch"), branch);
      header.append(branchHeading, refresh);
      const summary = element("div", "summary-line"), count = element("span", "change-count", "Project status");
      summary.append(count, element("span", "read-only", "Read-only"));
      const notice = element("div", "notice"), symbol = element("span", "notice-symbol"), message = element("p");
      symbol.setAttribute("aria-hidden", "true");
      symbol.hidden = true;
      message.setAttribute("role", "status");
      notice.append(symbol, message);
      const showMessage = (value, kind, mark = "") => {
        notice.hidden = !value;
        notice.dataset.kind = kind;
        text(message, value);
        text(symbol, mark);
        symbol.hidden = !mark;
      };
      showMessage("Checking Git…", "loading");
      const files = element("div", "files");
      const groups = ["staged", "unstaged", "untracked"].map((key) => {
        const title = key[0].toUpperCase() + key.slice(1), section = element("details"), heading = element("summary"), badge = element("span", "group-count", "0"), list = element("ul");
        section.dataset.group = key;
        section.open = true;
        section.hidden = true;
        list.setAttribute("aria-label", `${title} files`);
        heading.append(element("span", "", title), badge);
        section.append(heading, list);
        files.append(section);
        return { key, section, badge, list, fingerprint: "" };
      });
      const footer = element("footer"), automatic = element("span", "auto-refresh", "Auto-refresh · 5s"), updated = element("time", "updated", "Not checked yet");
      automatic.title = "Updates every five seconds while visible, and when you return to this window.";
      footer.append(automatic, updated);
      root.append(style, header, summary, notice, files, footer);
      container.replaceChildren(root);
      let visible = false, disposed = false, timer;
      let request, hasResult = false;
      const active = () => visible && !disposed && !context.signal.aborted && document.visibilityState === "visible";
      const render = (status) => {
        for (const group of groups) {
          const changes = status.state === "ready" ? status[group.key] : [];
          const fingerprint = JSON.stringify(changes);
          if (!changes.length && group.section.contains(document.activeElement))
            refresh.focus({ preventScroll: true });
          group.section.hidden = !changes.length;
          if (fingerprint === group.fingerprint)
            continue;
          group.fingerprint = fingerprint;
          text(group.badge, String(changes.length));
          group.list.replaceChildren(...changes.map(fileRow));
        }
        text(branch, status.state === "ready" ? status.detached ? "Detached HEAD" : status.branch ?? "Git" : "Git");
        branch.title = branch.textContent;
        const total = status.state === "ready" ? new Set([...status.staged, ...status.unstaged, ...status.untracked].map((file) => file.path)).size : 0;
        text(count, status.state === "not-repository" ? "Local project" : `${total}${status.truncated ? "+" : ""} changed ${total === 1 && !status.truncated ? "file" : "files"}`);
        if (status.state === "not-repository")
          showMessage("Not a Git repository.", "empty", "—");
        else if (status.truncated)
          showMessage("File list truncated. More changes are not shown.", "warning");
        else if (!total)
          showMessage("Working tree clean.", "empty", "✓");
        else
          showMessage("", "empty");
        const now = new Date;
        updated.dateTime = now.toISOString();
        text(updated, now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        updated.title = `Last successful check: ${now.toLocaleString()}`;
        root.dataset.stale = "false";
        hasResult = true;
      };
      const stop = () => {
        clearTimeout(timer);
        timer = undefined;
        request?.abort();
        request = undefined;
        refresh.removeAttribute("aria-busy");
      };
      const read = async () => {
        if (!active() || request)
          return;
        clearTimeout(timer);
        timer = undefined;
        const current = new AbortController;
        request = current;
        refresh.setAttribute("aria-busy", "true");
        try {
          const status = await context.project.gitStatus(current.signal);
          if (active() && request === current)
            render(status);
        } catch {
          if (active() && request === current) {
            root.dataset.stale = "true";
            showMessage(hasResult ? "Could not refresh; showing the previous result. Try Refresh." : "Git status unavailable. Try Refresh.", "warning");
          }
        } finally {
          if (request === current) {
            request = undefined;
            refresh.removeAttribute("aria-busy");
            if (active())
              timer = setTimeout(() => {
                read();
              }, 5000);
          }
        }
      };
      const onFocus = () => {
        read();
      };
      const onVisibility = () => {
        if (active())
          read();
        else
          stop();
      };
      const dispose = () => {
        if (disposed)
          return;
        disposed = true;
        stop();
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", onFocus);
        context.signal.removeEventListener("abort", dispose);
        root.remove();
      };
      refresh.addEventListener("click", onFocus);
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisibility);
      context.signal.addEventListener("abort", dispose, { once: true });
      if (context.signal.aborted)
        dispose();
      return { setVisible(value) {
        visible = value;
        root.hidden = !value;
        onVisibility();
      }, dispose };
    }
  });
}
export {
  register as default
};
