import type { AskUserQuestionRequest } from "@javis/tools";

export type AskUserAnswerHandler = (answer: string) => void | Promise<void>;

interface AskUserOptions {
  question: string;
  choices?: string[];
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
  const questionRequest: AskUserQuestionRequest = {
    id,
    question,
    choices,
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
