for (const button of document.querySelectorAll('[data-copy-command]')) {
  button.addEventListener('click', async () => {
    const status = document.getElementById(button.getAttribute('aria-describedby'));
    const command = button.getAttribute('data-copy-command');
    const label = button.getAttribute('data-copy-label');
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(command);
      status.textContent = `Copied ${label} command.`;
    } catch {
      status.textContent = 'Copy failed. Select the visible command and copy it manually.';
    }
  });
}
