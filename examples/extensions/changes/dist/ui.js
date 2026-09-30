// examples/extensions/changes/src/ui.ts
function register(host) {
  host.registerContextView({
    id: "changes",
    title: "Changes",
    mount(container, context) {
      const root = document.createElement("section");
      root.className = "wolfpack-changes";
      root.setAttribute("aria-label", "Git changes");
      const style = document.createElement("style");
      style.textContent = `.wolfpack-changes{display:flex;flex-direction:column;gap:12px;min-width:0;height:100%;color:var(--text,#dce5df);font:13px/1.5 system-ui}.wolfpack-changes header{display:flex;align-items:center;gap:8px;justify-content:space-between}.wolfpack-changes .branch{font-weight:600;overflow-wrap:anywhere;min-width:0}.wolfpack-changes button{font:inherit;color:inherit;background:transparent;border:1px solid var(--border,#435347);border-radius:6px;padding:6px 10px;min-height:44px;cursor:pointer}.wolfpack-changes button:focus-visible{outline:2px solid var(--accent,#55ee88);outline-offset:2px}.wolfpack-changes p,.wolfpack-changes h3{margin:0}.wolfpack-changes h3{font-size:12px;margin:12px 0 6px}.wolfpack-changes .files{overflow:auto;min-height:0;flex:1}.wolfpack-changes ul{list-style:none;margin:0;padding:0}.wolfpack-changes li{display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--border,#29352e)}.wolfpack-changes .path{font:12px/1.5 monospace;white-space:pre-wrap;overflow-wrap:anywhere;unicode-bidi:plaintext;min-width:0}.wolfpack-changes .kind{font-size:11px;flex:none;color:var(--text-muted,#a8b9ad)}.wolfpack-changes small{font-size:11px;color:var(--text-muted,#a8b9ad)}`;
      const header = document.createElement("header"), branch = document.createElement("span"), refresh = document.createElement("button");
      branch.className = "branch";
      branch.textContent = "Git";
      refresh.type = "button";
      refresh.textContent = "Refresh";
      refresh.setAttribute("aria-label", "Refresh Git status");
      header.append(branch, refresh);
      const message = document.createElement("p");
      message.setAttribute("role", "status");
      message.textContent = "Checking Git…";
      const files = document.createElement("div");
      files.className = "files";
      const updated = document.createElement("small");
      root.append(style, header, message, files, updated);
      container.replaceChildren(root);
      let visible = false, disposed = false, timer;
      let request, last = "", hasResult = false;
      const active = () => visible && !disposed && !context.signal.aborted && document.visibilityState === "visible";
      const group = (title, changes) => {
        if (!changes.length)
          return;
        const section = document.createElement("section"), heading = document.createElement("h3"), list = document.createElement("ul");
        heading.textContent = `${title} (${changes.length})`;
        list.setAttribute("aria-label", `${title} files`);
        for (const change of changes) {
          const row = document.createElement("li"), kind = document.createElement("span"), path = document.createElement("span");
          kind.className = "kind";
          kind.textContent = change.status;
          path.className = "path";
          path.textContent = change.previousPath ? `${change.previousPath} → ${change.path}` : change.path;
          path.title = change.path;
          row.append(kind, path);
          list.append(row);
        }
        section.append(heading, list);
        files.append(section);
      };
      const render = (status) => {
        const fingerprint = JSON.stringify(status);
        if (fingerprint !== last) {
          files.replaceChildren();
          last = fingerprint;
          if (status.state === "ready") {
            group("Staged", status.staged);
            group("Unstaged", status.unstaged);
            group("Untracked", status.untracked);
          }
        }
        branch.textContent = status.state === "ready" ? status.detached ? "Detached HEAD" : status.branch ?? "Git" : "Git";
        message.textContent = status.state === "not-repository" ? "Not a Git repository." : status.truncated ? "Showing the first 200 changed files. More changes are not shown." : status.staged.length + status.unstaged.length + status.untracked.length === 0 ? "Working tree clean." : "Read-only · updates every 5 seconds while visible.";
        updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
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
          if (active() && request === current)
            message.textContent = hasResult ? "Could not refresh; showing the previous result. Try Refresh." : "Git status unavailable. Try Refresh.";
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
      const onVisibility = () => {
        stop();
        if (active())
          read();
      };
      const dispose = () => {
        if (disposed)
          return;
        disposed = true;
        stop();
        document.removeEventListener("visibilitychange", onVisibility);
        context.signal.removeEventListener("abort", dispose);
        root.remove();
      };
      refresh.addEventListener("click", () => {
        read();
      });
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
