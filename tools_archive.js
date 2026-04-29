// ARCHIVED TOOLS JS - removed from main site
  function initTools() {
    // Tool page navigation
    document.querySelectorAll('[data-tool-page]').forEach(btn => {
      btn.addEventListener('click', () => _toolSwitchPage(btn.dataset.toolPage));
    });
    document.querySelectorAll('[data-goto-tool]').forEach(el => {
      el.addEventListener('click', (e) => { e.preventDefault(); _toolSwitchPage(el.dataset.gotoTool); });
    });

    // Legacy tool button support
    document.querySelectorAll('[data-tool]:not(.disabled)').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const id = el.getAttribute('data-tool');
        if (!state.user) return showLogin();
        if (id === 'desc-gen' || id === 'generator') _toolSwitchPage('descgen');
        else if (id === 'ai-chat' || id === 'chat') _toolSwitchPage('aichat');
        else if (id === 'roblox-checker' || id === 'checker') _toolSwitchPage('checker');
      });
    });

    // Mass Checker
    _initChecker();
    // Single Checker
    _initSingleChecker();
    // DescGen
    _initDescGen();
    // AI Chat
    _initAiChat();
    // Proxy Checker
    _initProxyChecker();
    // Checker mode toggle buttons
    document.querySelectorAll('.checker-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => _setCheckerMode(btn.dataset.checkerMode));
    });
  }
