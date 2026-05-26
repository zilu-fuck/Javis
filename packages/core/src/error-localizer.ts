const ERROR_TRANSLATIONS: Record<string, Record<string, string>> = {
  "zh-CN": {
    // Code patch errors
    "Code patch approval id is required.": "代码补丁审批 ID 是必填项。",
    "Code patch proposal id is required.": "代码补丁提案 ID 是必填项。",
    "Code patch cannot be empty.": "代码补丁不能为空。",
    "Code patch must list at least one approved changed file.": "代码补丁必须列出至少一个已批准变更的文件。",
    "Code patch hash does not match the approved proposal.": "代码补丁哈希与已批准提案不匹配。",
    "Code patch hash is required.": "代码补丁哈希是必填项。",
    "Code patch workspace path is required.": "代码补丁工作区路径是必填项。",
    "Patch includes an unapproved file path": "补丁包含未批准的文件路径：",
    "Changed file path must stay inside the selected workspace.": "变更文件路径必须在所选工作区内。",
    "Patch does not contain a unified diff header.": "补丁不包含 unified diff 头。",
    "Changed file path cannot be empty.": "变更文件路径不能为空。",
    "Changed file path must be relative": "变更文件路径必须是相对路径：",
    "Changed file path cannot contain parent directory traversal.": "变更文件路径不能包含父目录遍历。",
    "Changed file path does not have a parent directory.": "变更文件路径没有父目录。",
    "Changed file parent is not accessible": "变更文件父目录不可访问：",

    // Workspace errors
    "Workspace path cannot be empty.": "工作区路径不能为空。",
    "Selected workspace path is not accessible": "所选工作区路径不可访问：",
    "Selected workspace path is not a directory": "所选工作区路径不是目录：",
    "Workspace is not accessible": "工作区不可访问：",

    // Code proposal errors
    "Code proposal goal cannot be empty.": "代码提案目标不能为空。",
    "Code proposal requires a non-empty diff preview.": "代码提案需要非空 diff 预览。",
    "Code proposal includes a file outside the approved diff": "代码提案包含不在已批准 diff 内的文件：",

    // PDF organization errors
    "Only move PDF organization operations can be approved.": "只能批准 PDF 移动操作。",
    "PDF organization paths cannot contain parent directory traversal.": "PDF 整理路径不能包含父目录遍历。",
    "Approved PDF source cannot be read": "无法读取已批准的 PDF 源文件：",
    "Approved PDF organization paths must stay inside Downloads.": "已批准的 PDF 整理路径必须在 Downloads 内。",
    "Only PDF sources can be approved for organization.": "只能批准 PDF 文件进行整理。",
    "No pending PDF organization approval exists.": "没有待处理的 PDF 整理审批。",
    "No approved PDF organization dry-run is pending.": "没有已批准的 PDF 整理干运行。",
    "PDF organization approval id does not match the pending dry-run.": "PDF 整理审批 ID 与待处理的干运行不匹配。",
    "PDF organization dry-run has not been approved.": "PDF 整理干运行尚未被批准。",
    "Approved PDF organization operations do not match the current dry-run.": "已批准的 PDF 整理操作与当前干运行不一致。",

    // Approval binding errors
    "Approval id does not match the pending dry-run.": "审批 ID 与待处理的干运行不匹配。",
    "Approval tool binding does not match the pending dry-run.": "审批工具绑定与待处理的干运行不匹配。",
    "Approval preview hash does not match the pending dry-run.": "审批预览哈希与待处理的干运行不匹配。",
    "Approval tool binding does not match the approved dry-run.": "审批工具绑定与已批准的干运行不匹配。",
    "Approval preview hash does not match the approved dry-run.": "审批预览哈希与已批准的干运行不匹配。",
    "Code patch approval has not been approved.": "代码补丁审批尚未被批准。",
    "Code patch approval already consumed.": "代码补丁审批已被消费。",

    // PDF approval state errors
    "PDF approval state could not be locked.": "PDF 审批状态无法锁定。",

    // Shell command errors
    "Command is not in the first-version read-only allowlist.": "命令不在首个版本的只读白名单中。",

    // Web source errors
    "Only http and https URLs are supported.": "仅支持 HTTP 和 HTTPS URL。",

    // opencode errors
    "opencode did not return a parseable CodeProposedEdit JSON object.": "opencode 未返回可解析的代码提案 JSON 对象。",
    "OpenAI-compatible proposal fallback requires an API key.": "OpenAI 兼容降级需要 API 密钥。",
    "OpenAI-compatible proposal fallback requires a model.": "OpenAI 兼容降级需要模型。",
    "OpenAI-compatible proposal fallback failed": "OpenAI 兼容降级请求失败：",
    "OpenAI-compatible proposal fallback could not read response": "OpenAI 兼容降级无法读取响应：",
    "OpenAI-compatible proposal fallback returned invalid JSON": "OpenAI 兼容降级返回了无效 JSON：",
    "OpenAI-compatible proposal fallback returned no message content.": "OpenAI 兼容降级未返回消息内容。",
    "OpenAI-compatible proposal fallback returned empty message content.": "OpenAI 兼容降级返回了空消息内容。",

    // Model completion errors
    "Model completion requires an API key.": "模型补全需要 API 密钥。",
    "Model completion requires a model.": "模型补全需要模型。",
    "Model completion request failed": "模型补全请求失败：",
    "Model completion could not read response": "模型补全无法读取响应：",
    "Model completion returned invalid JSON": "模型补全返回了无效 JSON：",
    "Model completion returned no message content.": "模型补全未返回消息内容。",
    "Model completion returned empty message content.": "模型补全返回了空消息内容。",

    // API key secret errors
    "Model API key reference is required.": "模型 API 密钥引用是必填项。",
    "Unknown model API key reference.": "未知的模型 API 密钥引用。",
    "Could not read model API key secret": "无法读取模型 API 密钥：",
    "Could not save model API key secret": "无法保存模型 API 密钥：",
    "Could not delete model API key secret": "无法删除模型 API 密钥：",
    "Could not protect model API key secret.": "无法保护模型 API 密钥。",
    "Could not unprotect model API key secret.": "无法解开模型 API 密钥保护。",
    "Model API key secret is not protected.": "模型 API 密钥未受保护。",
    "Model API key secret is invalid": "模型 API 密钥无效：",
    "Model API key secret is not valid UTF-8": "模型 API 密钥不是有效的 UTF-8：",
    "Could not resolve app data directory": "无法解析应用数据目录：",
    "Could not create model secret directory": "无法创建模型密钥目录：",
    "Could not start git apply": "无法启动 git apply：",
    "Could not open git apply stdin.": "无法打开 git apply 标准输入。",
    "Could not write patch to git apply": "无法写入补丁到 git apply：",
    "Could not finish git apply": "无法完成 git apply：",
    "git apply failed without stderr.": "git apply 失败，无错误输出。",
    "Could not access OS credential store": "无法访问系统凭据存储",
    "Could not save model API key to OS credential store": "无法将模型 API 密钥保存到系统凭据存储",
    "Could not read model API key from OS credential store": "无法从系统凭据存储读取模型 API 密钥",
    "Could not delete model API key from OS credential store": "无法从系统凭据存储删除模型 API 密钥",
    "Model API key must be read from the OS credential store.": "模型 API 密钥必须从系统凭据存储读取。",
  },
};

export function localizeError(
  message: string,
  locale = "en",
): string {
  if (!locale.toLowerCase().startsWith("zh")) {
    return message;
  }

  const translations = ERROR_TRANSLATIONS["zh-CN"];
  if (!translations) {
    return message;
  }

  // Exact match first
  if (translations[message]) {
    return translations[message];
  }

  // Prefix match for messages with dynamic suffixes (e.g., "Patch includes an unapproved file path: foo.txt")
  for (const [key, value] of Object.entries(translations)) {
    if (message.startsWith(key)) {
      const rest = message.slice(key.length);
      return value + (rest ? rest : "");
    }
  }

  return message;
}

export function localizeOpenCodeError(
  message: string,
  locale = "en",
): string {
  if (!locale.toLowerCase().startsWith("zh")) {
    return message;
  }

  for (const [enPrefix, zhPrefix] of Object.entries(ERROR_TRANSLATIONS["zh-CN"])) {
    if (message.startsWith(enPrefix)) {
      return zhPrefix + message.slice(enPrefix.length);
    }
  }

  // Generic opencode error wrapper
  if (message.includes("opencode")) {
    return message.replace(
      /opencode/gi,
      "代码引擎",
    );
  }

  return message;
}
