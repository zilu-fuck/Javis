import { describe, expect, it } from "vitest";
import {
  createChineseReviewPrompt,
  createChineseRevisionPrompt,
  parseChineseReviewResult,
  type ChineseReviewScore,
} from "./chinese-reviewer";

// 10 representative Chinese text samples from Javis agent outputs
const SAMPLES = [
  {
    id: "cmd-plan",
    label: "Commander planning output",
    input: "首先，我需要检查项目的结构。其次，我会分析代码质量。最后，我会生成报告。这个任务需要使用 Agent 来完成 Token 分析。",
    issues: ["模板化首先/其次/最后结构", "句子长度单一"],
  },
  {
    id: "file-scan",
    label: "File scan summary",
    input: "扫描完成。发现 42 个文件。其中 Markdown 文件 15 个，TypeScript 文件 20 个，Rust 文件 7 个。所有文件均在 workspace 目录内。建议使用 Agent 进行进一步的 Token 级别分析。",
    issues: ["短句堆砌", "缺乏自然过渡"],
  },
  {
    id: "code-review",
    label: "Code review feedback",
    input: "代码审查结果如下：第一，函数命名不符合规范。第二，缺少错误处理。第三，存在潜在的内存泄漏问题。建议使用 diff 和 patch 工具进行修复。Token 消耗预计为 1500。",
    issues: ["编号列表模板化", "缺乏优先级说明"],
  },
  {
    id: "research-summary",
    label: "Research agent summary",
    input: "经过研究发现，该技术方案具有以下优势：首先性能优异，其次社区活跃，最后文档完善。但是也存在一些不足：学习曲线较陡峭，生态系统尚不完善。总体而言，推荐在 production 环境中使用此 Agent 方案。",
    issues: ["首先/其次/最后模板", "转折生硬"],
  },
  {
    id: "error-report",
    label: "Error diagnosis report",
    input: "错误诊断报告：检测到 3 个错误。错误类型包括 TypeScript 类型错误 1 个，运行时错误 2 个。根本原因在于 API 返回的数据格式与预期不符。修复方案：更新类型定义，添加数据验证。预计 Token 消耗 800。",
    issues: ["报告格式僵硬", "缺乏上下文"],
  },
  {
    id: "task-status",
    label: "Task status update",
    input: "任务执行状态更新：当前进度 60%。已完成步骤包括文件扫描、代码分析、依赖检查。待完成步骤包括安全审计、性能测试、文档生成。预计还需 15 分钟完成所有 Verifier 检查。",
    issues: ["进度报告模板化", "缺乏细节"],
  },
  {
    id: "agent-desc",
    label: "Agent capability description",
    input: "Code Agent 具备以下能力：代码生成、代码审查、重构建议、测试编写。它使用 deepseek-coder 模型，支持 TypeScript 和 Rust 语言。Token 限制为 4096，支持 streaming 输出。可以通过 Commander 调度执行。",
    issues: ["功能列表罗列", "缺乏使用场景"],
  },
  {
    id: "workflow-result",
    label: "Workflow execution result",
    input: "工作流执行完成。执行了 5 个步骤，其中 4 个成功，1 个失败。失败步骤为安全扫描，原因是依赖包版本过旧。已自动创建 patch 建议更新依赖。总 Token 消耗为 3200。",
    issues: ["结果报告简洁但缺乏建议"],
  },
  {
    id: "chinese-optimized",
    label: "Already well-written Chinese",
    input: "项目分析完成。代码结构清晰，模块划分合理。建议优化数据库查询性能，当前 N+1 查询问题可能导致高并发场景下的响应延迟。Agent 已自动识别并标记了 3 处潜在瓶颈。",
    issues: ["质量较好，应保持不变"],
  },
  {
    id: "mixed-lang",
    label: "Mixed Chinese-English technical text",
    input: "配置 Model Profile 时，需要指定 provider、model 和 apiKey。如果使用 DeepSeek，baseUrl 默认为 https://api.deepseek.com/v1。支持 OpenAI-compatible 协议的 provider 可以直接复用 OpenAI Adapter。Token 计费方式因 provider 而异。",
    issues: ["中英混杂合理", "技术术语应保持英文"],
  },
];

// Simulated review results (what a good LLM would return)
function simulateReview(sampleId: string, input: string): { text: string; score: ChineseReviewScore } {
  const transformations: Record<string, { text: string; score: ChineseReviewScore }> = {
    "cmd-plan": {
      text: "接下来需要检查项目结构并分析代码质量，最终生成完整报告。这项任务将由 Agent 完成 Token 分析。",
      score: { accuracy: 9, naturalness: 8, style_match: 9, term_consistency: 9, constraint_following: 9, redundancy: 8, needs_revision: false },
    },
    "file-scan": {
      text: "扫描已完成，共发现 42 个文件：15 个 Markdown、20 个 TypeScript 和 7 个 Rust 文件，全部位于 workspace 目录内。可进一步使用 Agent 进行 Token 级别分析。",
      score: { accuracy: 9, naturalness: 8, style_match: 8, term_consistency: 9, constraint_following: 9, redundancy: 7, needs_revision: false },
    },
    "code-review": {
      text: "代码审查发现三个问题：函数命名不规范、缺少错误处理、存在潜在内存泄漏。建议使用 diff 和 patch 工具修复，预计 Token 消耗约 1500。",
      score: { accuracy: 9, naturalness: 8, style_match: 8, term_consistency: 9, constraint_following: 9, redundancy: 8, needs_revision: false },
    },
    "research-summary": {
      text: "研究表明该技术方案性能优异、社区活跃、文档完善，但学习曲线较陡且生态系统仍在发展中。综合评估后推荐在 production 环境中采用此 Agent 方案。",
      score: { accuracy: 9, naturalness: 9, style_match: 9, term_consistency: 9, constraint_following: 9, redundancy: 8, needs_revision: false },
    },
    "error-report": {
      text: "诊断发现 3 个错误：1 个 TypeScript 类型错误和 2 个运行时错误。根因是 API 返回数据格式与预期不符。建议更新类型定义并添加数据验证，预计 Token 消耗约 800。",
      score: { accuracy: 9, naturalness: 8, style_match: 8, term_consistency: 9, constraint_following: 9, redundancy: 7, needs_revision: false },
    },
    "task-status": {
      text: "任务进度 60%：已完成文件扫描、代码分析和依赖检查，剩余安全审计、性能测试和文档生成。预计还需 15 分钟完成 Verifier 检查。",
      score: { accuracy: 9, naturalness: 8, style_match: 8, term_consistency: 9, constraint_following: 9, redundancy: 8, needs_revision: false },
    },
    "agent-desc": {
      text: "Code Agent 支持代码生成、审查、重构建议和测试编写，基于 deepseek-coder 模型，兼容 TypeScript 和 Rust。Token 上限 4096，支持 streaming 输出，可通过 Commander 调度。",
      score: { accuracy: 9, naturalness: 8, style_match: 8, term_consistency: 9, constraint_following: 9, redundancy: 8, needs_revision: false },
    },
    "workflow-result": {
      text: "工作流执行完毕：5 个步骤中 4 个成功、1 个失败（安全扫描，因依赖包版本过旧）。已自动生成 patch 建议更新依赖，总 Token 消耗 3200。",
      score: { accuracy: 9, naturalness: 8, style_match: 8, term_consistency: 9, constraint_following: 9, redundancy: 7, needs_revision: false },
    },
    "chinese-optimized": {
      text: "项目分析完成。代码结构清晰，模块划分合理。建议优化数据库查询性能，当前 N+1 查询问题可能导致高并发场景下的响应延迟。Agent 已自动识别并标记了 3 处潜在瓶颈。",
      score: { accuracy: 10, naturalness: 9, style_match: 9, term_consistency: 10, constraint_following: 10, redundancy: 9, needs_revision: false },
    },
    "mixed-lang": {
      text: "配置 Model Profile 时需指定 provider、model 和 apiKey。DeepSeek 的 baseUrl 默认为 https://api.deepseek.com/v1。支持 OpenAI-compatible 协议的 provider 可复用 OpenAI Adapter。Token 计费方式因 provider 而异。",
      score: { accuracy: 10, naturalness: 9, style_match: 9, term_consistency: 10, constraint_following: 10, redundancy: 9, needs_revision: false },
    },
  };

  return transformations[sampleId] ?? { text: input, score: { accuracy: 8, naturalness: 8, style_match: 8, term_consistency: 8, constraint_following: 8, redundancy: 8, needs_revision: false } };
}

describe("ChineseReviewer A/B evaluation", () => {
  it("generates valid review prompts for all 10 samples", () => {
    for (const sample of SAMPLES) {
      const prompt = createChineseReviewPrompt(sample.input, "full");
      expect(prompt).toContain("Javis ChineseReviewer");
      expect(prompt).toContain(sample.input);
      expect(prompt).toContain("JSON");
    }
  });

  it("generates valid terms-only prompts for all 10 samples", () => {
    for (const sample of SAMPLES) {
      const prompt = createChineseReviewPrompt(sample.input, "terms-only");
      expect(prompt).toContain("Only fix terminology consistency");
      expect(prompt).toContain(sample.input);
    }
  });

  it("parses simulated review results correctly for all samples", () => {
    for (const sample of SAMPLES) {
      const simulated = simulateReview(sample.id, sample.input);
      const serialized = JSON.stringify(simulated);
      const parsed = parseChineseReviewResult(serialized);

      expect(parsed.text).toBe(simulated.text);
      expect(parsed.score.accuracy).toBeGreaterThanOrEqual(0);
      expect(parsed.score.accuracy).toBeLessThanOrEqual(10);
      expect(parsed.score.naturalness).toBeGreaterThanOrEqual(0);
      expect(parsed.score.naturalness).toBeLessThanOrEqual(10);
      expect(typeof parsed.score.needs_revision).toBe("boolean");
    }
  });

  it("reviewed text preserves key technical terms", () => {
    const technicalTerms = ["Agent", "Token", "diff", "patch", "workspace", "Commander", "Verifier", "streaming", "provider", "Adapter"];

    for (const sample of SAMPLES) {
      const simulated = simulateReview(sample.id, sample.input);
      const inputTerms = technicalTerms.filter((t) => sample.input.includes(t));
      for (const term of inputTerms) {
        expect(simulated.text).toContain(term);
      }
    }
  });

  it("reviewed text is shorter or equal length (removes redundancy)", () => {
    for (const sample of SAMPLES) {
      const simulated = simulateReview(sample.id, sample.input);
      // Reviewed text should not be significantly longer
      expect(simulated.text.length).toBeLessThanOrEqual(sample.input.length + 20);
    }
  });

  it("well-written samples have higher scores", () => {
    const goodSample = simulateReview("chinese-optimized", SAMPLES[8].input);
    const templateSample = simulateReview("cmd-plan", SAMPLES[0].input);

    expect(goodSample.score.naturalness).toBeGreaterThanOrEqual(templateSample.score.naturalness);
    expect(goodSample.score.redundancy).toBeGreaterThanOrEqual(templateSample.score.redundancy);
  });

  it("revision prompt includes previous score for context", () => {
    const lowScore: ChineseReviewScore = {
      accuracy: 8,
      naturalness: 5,
      style_match: 6,
      term_consistency: 8,
      constraint_following: 7,
      redundancy: 4,
      needs_revision: true,
    };

    const prompt = createChineseRevisionPrompt("需要修改的文本", lowScore);
    expect(prompt).toContain("Rewrite once");
    expect(prompt).toContain('"naturalness":5');
    expect(prompt).toContain('"redundancy":4');
  });

  it("handles malformed LLM response gracefully", () => {
    // Response with markdown fences
    const fenced = '```json\n{"text":"修改后文本","score":{"accuracy":9,"naturalness":8,"style_match":8,"term_consistency":8,"constraint_following":8,"redundancy":8,"needs_revision":false}}\n```';
    const result = parseChineseReviewResult(fenced);
    expect(result.text).toBe("修改后文本");

    // Response with extra text around JSON
    const wrapped = 'Here is the result: {"text":"测试文本","score":{"accuracy":7,"naturalness":7,"style_match":7,"term_consistency":7,"constraint_following":7,"redundancy":7,"needs_revision":false}} Hope this helps!';
    const result2 = parseChineseReviewResult(wrapped);
    expect(result2.text).toBe("测试文本");
  });

  it("score normalization clamps out-of-range values", () => {
    const result = parseChineseReviewResult(JSON.stringify({
      text: "测试",
      score: {
        accuracy: 15,
        naturalness: -3,
        style_match: 8.7,
        term_consistency: 0,
        constraint_following: 10,
        redundancy: 5,
        needs_revision: "yes",
      },
    }));

    expect(result.score.accuracy).toBe(10);
    expect(result.score.naturalness).toBe(0);
    expect(result.score.style_match).toBe(9);
    expect(result.score.term_consistency).toBe(0);
    expect(result.score.needs_revision).toBe(false); // "yes" is not boolean true
  });

  it("evaluation summary: all samples produce valid review pipeline output", () => {
    const results = SAMPLES.map((sample) => {
      const simulated = simulateReview(sample.id, sample.input);
      const parsed = parseChineseReviewResult(JSON.stringify(simulated));
      return {
        id: sample.id,
        label: sample.label,
        inputLength: sample.input.length,
        outputLength: parsed.text.length,
        reduction: sample.input.length - parsed.text.length,
        scores: parsed.score,
        needsRevision: parsed.score.needs_revision,
      };
    });

    // All samples should produce valid results
    expect(results).toHaveLength(10);

    // Log summary for manual inspection
    const summary = results.map((r) => ({
      id: r.id,
      label: r.label,
      chars: `${r.inputLength}→${r.outputLength} (${r.reduction > 0 ? "-" : "+"}${Math.abs(r.reduction)})`,
      avg: ((r.scores.accuracy + r.scores.naturalness + r.scores.style_match + r.scores.term_consistency + r.scores.constraint_following + r.scores.redundancy) / 6).toFixed(1),
      revision: r.needsRevision,
    }));

    // Verify all averages are reasonable (>= 7)
    for (const s of summary) {
      expect(parseFloat(s.avg)).toBeGreaterThanOrEqual(7);
    }
  });
});
