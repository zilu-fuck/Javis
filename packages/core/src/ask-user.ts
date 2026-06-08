import type { AskUserChoice, AskUserQuestionRequest } from "@javis/tools";

export type AskUserAnswerHandler = (answer: string) => void | Promise<void>;

interface AskUserOptions {
  question: string;
  choices?: Array<string | AskUserChoice>;
  setPendingAskUserHandler(
    requestId: string,
    handler: AskUserAnswerHandler | undefined,
  ): void;
  onAnswered(resolvedRequest: AskUserQuestionRequest): void | Promise<void>;
}

interface AskUserResult {
  questionRequest: AskUserQuestionRequest;
  listenForAnswer(): void;
}

export function createAskUserRequest({
  question,
  choices,
  setPendingAskUserHandler,
  onAnswered,
}: AskUserOptions): AskUserResult {
  const id = `askuser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalized = normalizeSingleQuestion(question, choices);
  const questionRequest: AskUserQuestionRequest = {
    id,
    question: normalized.question,
    choices: normalized.choices,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  return {
    questionRequest,
    listenForAnswer() {
      setPendingAskUserHandler(id, async (answer) => {
        const resolved: AskUserQuestionRequest = {
          ...questionRequest,
          status: "answered",
          answer,
          resolvedAt: new Date().toISOString(),
        };
        setPendingAskUserHandler(id, undefined);
        await onAnswered(resolved);
      });
    },
  };
}

function normalizeSingleQuestion(
  question: string,
  choices: Array<string | AskUserChoice> | undefined,
): { question: string; choices?: Array<string | AskUserChoice> } {
  if (!choices?.length) {
    return { question };
  }
  const questionLikeChoices = choices.filter((choice) => isQuestionLike(choiceLabel(choice)));
  if (questionLikeChoices.length === 0) {
    return { question, choices };
  }
  return {
    question: choiceLabel(questionLikeChoices[0]) || question,
    choices: undefined,
  };
}

function choiceLabel(choice: string | AskUserChoice): string {
  return typeof choice === "string" ? choice.trim() : choice.label.trim();
}

function isQuestionLike(value: string): boolean {
  return /[?\uFF1F]\s*$/.test(value) || /^(which|what|where|when|how|why|who)\b/i.test(value);
}
