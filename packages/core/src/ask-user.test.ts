import { describe, expect, it, vi } from "vitest";
import { createAskUserRequest } from "./ask-user";

describe("createAskUserRequest", () => {
  it("keeps clarification focused on one question when choices contain multiple questions", () => {
    const request = createAskUserRequest({
      question: "Clarify requirements",
      choices: [
        "Where is the wallpaper folder?",
        "Which technology stack should I use?",
        { label: "Where should the project code live?", value: "project-path" },
      ],
      setPendingAskUserHandler: vi.fn(),
      onAnswered: vi.fn(),
    }).questionRequest;

    expect(request.question).toBe("Where is the wallpaper folder?");
    expect(request.choices).toBeUndefined();
  });

  it("keeps answer choices when they are options for the same question", () => {
    const choices = ["React", "Vue", { label: "Help me decide", value: "__help__" }];
    const request = createAskUserRequest({
      question: "Which technology stack should I use?",
      choices,
      setPendingAskUserHandler: vi.fn(),
      onAnswered: vi.fn(),
    }).questionRequest;

    expect(request.question).toBe("Which technology stack should I use?");
    expect(request.choices).toEqual(choices);
  });
});
