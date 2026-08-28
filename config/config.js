var MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
var KEY_CHECK_DEBOUNCE_MS = 400;
var CUSTOM_MODEL = '__custom__';
var KNOWN_MODELS = [
  { id: 'claude-opus-5' },
  { id: 'claude-sonnet-5' },
  { id: 'claude-haiku-4-5' },
  { id: 'claude-fable-5' },
  { id: 'claude-opus-4-8' },
  { id: 'claude-opus-4-7' },
  { id: 'claude-opus-4-6' },
  { id: 'claude-sonnet-4-6' }
];

function getQueryParam(param) {
  var query = location.search.substring(1);
  var vars = query.split('&');
  for (var i = 0; i < vars.length; i++) {
    var pair = vars[i].split('=');
    if (decodeURIComponent(pair[0]) == param) {
      return decodeURIComponent(pair[1]);
    }
  }
  return null;
}

var defaults = {
  base_url: 'https://api.anthropic.com/v1/messages',
  model: 'claude-haiku-4-5',
  system_message: "You're running on a Pebble smartwatch. Please respond in plain text without any formatting, keeping your responses within 1-3 sentences."
};

var apiKey = getQueryParam('api_key');
var baseUrl = getQueryParam('base_url');
var model = getQueryParam('model');
var systemMessage = getQueryParam('system_message');
var webSearchEnabled = getQueryParam('web_search_enabled');
var mcpServers = getQueryParam('mcp_servers');

var returnTo = getQueryParam('return_to') || 'pebblejs://close#';

function normalizedBaseUrl(value) {
  return value.trim().replace(/\/+$/, '');
}

function modelsUrlFrom(messagesUrl) {
  if (messagesUrl === defaults.base_url) {
    return MODELS_URL;
  }
  if (/\/v1\/messages\/?$/.test(messagesUrl)) {
    return messagesUrl.replace(/\/v1\/messages\/?$/, '/v1/models');
  }
  return null;
}

function keyKind(key) {
  if ('sk-ant-'.indexOf(key) === 0) {
    return 'partial';
  }
  if (key.indexOf('sk-ant-sid') === 0) {
    return 'session';
  }
  if (key.indexOf('sk-ant-oat') === 0) {
    return 'oauth';
  }
  if (key.indexOf('sk-ant-') === 0) {
    return 'api';
  }
  return 'unknown';
}

function setKeyStatus(state, text) {
  var status = document.getElementById('key-status');
  status.className = state;
  status.textContent = text;
}

function errorMessageFrom(responseText) {
  try {
    return JSON.parse(responseText).error.message;
  } catch (e) {
    return null;
  }
}

function modelsFrom(responseText) {
  try {
    return JSON.parse(responseText).data.filter(function (entry) {
      return entry.id;
    });
  } catch (e) {
    return null;
  }
}

function toggleCustomModel() {
  var isCustom = document.getElementById('model').value === CUSTOM_MODEL;
  document.getElementById('custom-model').style.display = isCustom ? '' : 'none';
}

function selectedModel() {
  var select = document.getElementById('model');
  if (select.value === CUSTOM_MODEL) {
    return document.getElementById('custom-model').value.trim();
  }
  return select.value;
}

function populateModels(models, selectedId) {
  var select = document.getElementById('model');
  select.innerHTML = '';
  for (var i = 0; i < models.length; i++) {
    var option = document.createElement('option');
    option.value = models[i].id;
    option.textContent = models[i].display_name || models[i].id;
    select.appendChild(option);
  }
  var custom = document.createElement('option');
  custom.value = CUSTOM_MODEL;
  custom.textContent = 'Custom…';
  select.appendChild(custom);

  select.value = selectedId;
  if (select.selectedIndex === -1) {
    select.value = CUSTOM_MODEL;
    document.getElementById('custom-model').value = selectedId;
  }
  toggleCustomModel();
}

var keyCheckSequence = 0;

function checkKey(key, messagesUrl) {
  var sequence = ++keyCheckSequence;

  function whenCurrent(handler) {
    return function () {
      if (sequence === keyCheckSequence) {
        handler();
      }
    };
  }

  var kind = keyKind(key);
  if (kind === 'partial') {
    setKeyStatus('', '');
    return;
  }
  var isDefaultBase = messagesUrl === defaults.base_url;
  var checkUrl = modelsUrlFrom(messagesUrl);
  if (!checkUrl) {
    setKeyStatus('notice', 'Keys cannot be checked against this base URL.');
    return;
  }
  if (isDefaultBase) {
    if (kind === 'unknown') {
      setKeyStatus('invalid', '✗ Anthropic keys start with sk-ant-');
      return;
    }
    if (kind === 'session') {
      setKeyStatus('notice', 'This is a claude.ai session key. The Pebble app cannot use it. Paste an API key from console.anthropic.com instead.');
      return;
    }
  }

  setKeyStatus('checking', 'Checking key…');

  var xhr = new XMLHttpRequest();
  xhr.open('GET', checkUrl, true);
  xhr.setRequestHeader('anthropic-version', '2023-06-01');
  xhr.setRequestHeader('anthropic-dangerous-direct-browser-access', 'true');
  if (kind === 'oauth') {
    xhr.setRequestHeader('Authorization', 'Bearer ' + key);
    xhr.setRequestHeader('anthropic-beta', 'oauth-2025-04-20');
  } else {
    xhr.setRequestHeader('x-api-key', key);
  }
  xhr.timeout = 10000;

  xhr.onload = whenCurrent(function () {
    if (xhr.status !== 200) {
      if (isDefaultBase || xhr.status === 401 || xhr.status === 403) {
        var message = errorMessageFrom(xhr.responseText);
        setKeyStatus('invalid', '✗ Rejected (' + xhr.status + ')' + (message ? ': ' + message : ''));
      } else {
        setKeyStatus('notice', 'This server does not offer a key check (status ' + xhr.status + ').');
      }
      return;
    }
    var models = modelsFrom(xhr.responseText);
    if (!models) {
      if (isDefaultBase) {
        setKeyStatus('invalid', '✗ Unexpected response from the API.');
      } else {
        setKeyStatus('notice', 'This server did not return a model list.');
      }
      return;
    }
    populateModels(models, selectedModel());
    setKeyStatus('valid', '✓ Key works. ' + models.length + ' models available.');
  });

  xhr.onerror = whenCurrent(function () {
    if (isDefaultBase) {
      setKeyStatus('invalid', '✗ Could not reach the API.');
    } else {
      setKeyStatus('notice', 'Could not reach this server.');
    }
  });

  xhr.ontimeout = whenCurrent(function () {
    if (isDefaultBase) {
      setKeyStatus('invalid', '✗ The API did not answer in time.');
    } else {
      setKeyStatus('notice', 'This server did not answer in time.');
    }
  });

  xhr.send();
}

document.addEventListener('DOMContentLoaded', function () {
  var apiKeyInput = document.getElementById('api-key');
  var baseUrlInput = document.getElementById('base-url');
  var advancedRows = document.querySelectorAll('.advanced-field');
  var keyCheckTimer = null;

  if (apiKey) {
    apiKeyInput.value = apiKey;
  }
  baseUrlInput.value = baseUrl || defaults.base_url;
  populateModels(KNOWN_MODELS, model || defaults.model);
  document.getElementById('system-message').value = systemMessage || defaults.system_message;
  document.getElementById('web-search').checked = webSearchEnabled === 'true';
  document.getElementById('mcp-servers').value = mcpServers || '';

  function toggleAdvancedFields() {
    var hasApiKey = apiKeyInput.value.trim() !== '';
    advancedRows.forEach(function (row) {
      row.style.display = hasApiKey ? '' : 'none';
    });
  }

  function checkKeyNow() {
    clearTimeout(keyCheckTimer);
    checkKey(apiKeyInput.value.trim(), normalizedBaseUrl(baseUrlInput.value) || defaults.base_url);
  }

  function scheduleKeyCheck() {
    clearTimeout(keyCheckTimer);
    keyCheckTimer = setTimeout(checkKeyNow, KEY_CHECK_DEBOUNCE_MS);
  }

  toggleAdvancedFields();
  checkKeyNow();

  apiKeyInput.addEventListener('input', function () {
    toggleAdvancedFields();
    scheduleKeyCheck();
  });
  baseUrlInput.addEventListener('change', checkKeyNow);
  document.getElementById('model').addEventListener('change', toggleCustomModel);

  document.getElementById('save-button').addEventListener('click', function () {
    var mcpServersValue = document.getElementById('mcp-servers').value.trim();

    if (selectedModel() === '') {
      alert('Enter a model ID or pick one from the list');
      return;
    }

    if (mcpServersValue) {
      try {
        var parsed = JSON.parse(mcpServersValue);
        if (!Array.isArray(parsed)) {
          alert('MCP Servers must be a JSON array');
          return;
        }
      } catch (e) {
        alert('Invalid JSON in MCP Servers field: ' + e.message);
        return;
      }
    }

    var settings = {
      api_key: apiKeyInput.value.trim(),
      base_url: normalizedBaseUrl(baseUrlInput.value),
      model: selectedModel(),
      system_message: document.getElementById('system-message').value.trim(),
      web_search_enabled: document.getElementById('web-search').checked.toString(),
      mcp_servers: mcpServersValue
    };

    var url = returnTo + encodeURIComponent(JSON.stringify(settings));
    document.location = url;
  });

  document.getElementById('reset-button').addEventListener('click', function () {
    apiKeyInput.value = '';
    baseUrlInput.value = defaults.base_url;
    populateModels(KNOWN_MODELS, defaults.model);
    document.getElementById('system-message').value = defaults.system_message;
    document.getElementById('web-search').checked = false;
    document.getElementById('mcp-servers').value = '';

    toggleAdvancedFields();
    checkKeyNow();

    var settings = {
      api_key: '',
      base_url: defaults.base_url,
      model: defaults.model,
      system_message: defaults.system_message,
      web_search_enabled: 'false',
      mcp_servers: ''
    };

    var url = returnTo + encodeURIComponent(JSON.stringify(settings));
    document.location = url;
  });
});
