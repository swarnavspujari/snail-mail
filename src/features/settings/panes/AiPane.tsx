import { useState } from "react";
import { Button } from "@/components/Button";
import { Pill } from "@/components/Pill";
import { RowGroup, SettingRow, WideRow } from "@/components/SettingRow";
import { backend } from "@/lib/ipc";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Pref } from "../Pref";
import { useReceipt } from "../receipt";
import type { AiProviderId } from "@/lib/types";

const inputCls =
  "w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";

export function AiPane() {
  return (
    <>
      <ProvidersSection />
      <RowGroup title="Semantic search">
        <Pref id="embeddings" />
      </RowGroup>
      <KnowledgeSection />
    </>
  );
}

function ProvidersSection() {
  const settings = useSettings((s) => s.settings);
  const [expanded, setExpanded] = useState<AiProviderId | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});

  const pick = (id: AiProviderId, label: string) => {
    const before = settings.defaultAiProvider;
    void useSettings.getState().save({ defaultAiProvider: id });
    useReceipt
      .getState()
      .note(`${label} is now the default provider`, () =>
        useSettings.getState().save({ defaultAiProvider: before })
      );
  };

  const patch = (
    id: AiProviderId,
    p: Partial<(typeof settings.providers)[number]>
  ) => {
    void useSettings.getState().save({
      providers: settings.providers.map((x) => (x.id === id ? { ...x, ...p } : x)),
    });
  };

  return (
    <RowGroup
      title="Default provider"
      colLabel="Key"
      hint="Only the provider you pick ever sees your mail. Keys live in one place — Privacy & keys."
    >
      {settings.providers.map((p) => {
        const isDefault = settings.defaultAiProvider === p.id;
        return (
          <div key={p.id}>
            <SettingRow
              label={
                <span className="flex items-center gap-2">
                  <button
                    role="radio"
                    aria-checked={isDefault}
                    aria-label={`Use ${p.label}`}
                    onClick={() => pick(p.id, p.label)}
                    className={`relative h-[15px] w-[15px] shrink-0 rounded-full border ${
                      isDefault ? "border-accent" : "border-line-strong"
                    }`}
                  >
                    <span
                      className={`absolute inset-[3px] rounded-full ${
                        isDefault ? "bg-accent" : "bg-transparent"
                      }`}
                    />
                  </button>
                  {p.label}
                </span>
              }
              help={`${p.model}${p.baseUrl ? ` · ${p.baseUrl}` : ""}`}
              tag={isDefault ? <Pill tone="accent">default</Pill> : undefined}
            >
              <Pill tone={p.hasKey ? "success" : "neutral"}>
                {p.hasKey ? "stored" : "no key"}
              </Pill>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => setExpanded(expanded === p.id ? null : p.id)}
              >
                {expanded === p.id ? "Close" : "Model"}
              </Button>
            </SettingRow>
            {expanded === p.id && (
              <WideRow>
                <div className="flex flex-wrap gap-2">
                  <input
                    className={inputCls}
                    value={p.model}
                    onKeyDown={(e) => e.stopPropagation()}
                    onChange={(e) => patch(p.id, { model: e.target.value })}
                    title="Model"
                  />
                  {p.id === "nim" && (
                    <input
                      className={inputCls}
                      value={p.baseUrl ?? ""}
                      onKeyDown={(e) => e.stopPropagation()}
                      onChange={(e) => patch(p.id, { baseUrl: e.target.value })}
                      placeholder="Base URL (hosted or self-hosted NIM)"
                      title="OpenAI-compatible base URL"
                    />
                  )}
                  <div className="flex w-full items-center gap-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setStatus((s) => ({ ...s, [p.id]: "Testing…" }));
                        void backend
                          .testAiProvider(p.id)
                          .then((r) =>
                            setStatus((s) => ({
                              ...s,
                              [p.id]: `${r.ok ? "✓" : "✗"} ${r.message}`,
                            }))
                          )
                          .catch((e) =>
                            setStatus((s) => ({ ...s, [p.id]: `✗ ${String(e)}` }))
                          );
                      }}
                    >
                      Test connection
                    </Button>
                    {status[p.id] && (
                      <span className="text-[12px] text-ink-2">{status[p.id]}</span>
                    )}
                    <div className="flex-1" />
                    <button
                      className="text-[12px] text-ink-3 underline hover:text-ink-2"
                      onClick={() => useUi.getState().setSettingsTab("privacy")}
                    >
                      Manage this key in Privacy &amp; keys
                    </button>
                  </div>
                </div>
              </WideRow>
            )}
          </div>
        );
      })}
    </RowGroup>
  );
}

function KnowledgeSection() {
  const kb = useSettings((s) => s.kb);
  const [open, setOpen] = useState<"instructions" | "snippets" | "voice" | null>(
    null
  );
  const [draft, setDraft] = useState(kb.instructions);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const save = (patch: Partial<typeof kb>, label: string) => {
    const before = kb;
    void useSettings.getState().saveKb({ ...kb, ...patch });
    useReceipt
      .getState()
      .note(label, () => useSettings.getState().saveKb(before));
  };

  const list = open === "snippets" ? kb.snippets : kb.voiceExamples;

  return (
    <RowGroup
      title="Knowledge base"
      hint="What the AI knows about how you write. Injected into every draft."
    >
      <SettingRow
        label="Standing instructions"
        help={
          kb.instructions.trim()
            ? kb.instructions.slice(0, 90) + (kb.instructions.length > 90 ? "…" : "")
            : "How the AI should sound, and rules it must always follow."
        }
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setDraft(kb.instructions);
            setOpen(open === "instructions" ? null : "instructions");
          }}
        >
          {open === "instructions" ? "Close" : "Edit"}
        </Button>
      </SettingRow>
      {open === "instructions" && (
        <WideRow>
          <textarea
            className={`${inputCls} min-h-28 resize-y`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={() => {
              if (draft !== kb.instructions)
                save({ instructions: draft }, "Standing instructions saved");
            }}
            placeholder={
              'e.g. "Be warm but brief. Never use exclamation marks. When scheduling, propose two concrete times."'
            }
          />
          <p className="mt-1.5 text-[11.5px] text-ink-3">
            Commits when you click away — no Save button, and Ctrl+Z undoes it.
          </p>
        </WideRow>
      )}

      {(["snippets", "voice"] as const).map((which) => {
        const items = which === "snippets" ? kb.snippets : kb.voiceExamples;
        return (
          <SettingRow
            key={which}
            label={which === "snippets" ? "Snippets" : "Voice examples"}
            help={
              which === "snippets"
                ? "Reusable blocks the AI can weave in — bios, disclaimers, booking links."
                : "Mail you've written that sounds like you."
            }
            tag={<Pill tone="neutral">{items.length}</Pill>}
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setTitle("");
                setBody("");
                setOpen(open === which ? null : which);
              }}
            >
              {open === which ? "Close" : "Manage"}
            </Button>
          </SettingRow>
        );
      })}

      {(open === "snippets" || open === "voice") && (
        <WideRow>
          <div className="space-y-2">
            {list.map((s) => (
              <div
                key={s.id}
                className="flex items-start gap-3 rounded-md border border-line bg-raised px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink">{s.title}</div>
                  <div className="truncate text-[12px] text-ink-3">{s.body}</div>
                </div>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    save(
                      open === "snippets"
                        ? { snippets: kb.snippets.filter((x) => x.id !== s.id) }
                        : {
                            voiceExamples: kb.voiceExamples.filter(
                              (x) => x.id !== s.id
                            ),
                          },
                      `“${s.title}” removed`
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <input
              className={inputCls}
              placeholder={
                open === "snippets"
                  ? "Snippet title"
                  : 'Label, e.g. "how I decline pitches"'
              }
              value={title}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className={`${inputCls} min-h-16 resize-y`}
              placeholder={
                open === "snippets" ? "Snippet text" : "Paste the example email"
              }
              value={body}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setBody(e.target.value)}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!title.trim() || !body.trim()}
              onClick={() => {
                const item = {
                  id: `${open === "snippets" ? "snip" : "ex"}-${Date.now()}`,
                  title: title.trim(),
                  body: body.trim(),
                };
                save(
                  open === "snippets"
                    ? { snippets: [...kb.snippets, item] }
                    : { voiceExamples: [...kb.voiceExamples, item] },
                  `“${item.title}” added`
                );
                setTitle("");
                setBody("");
              }}
            >
              {open === "snippets" ? "Add snippet" : "Add example"}
            </Button>
          </div>
        </WideRow>
      )}
    </RowGroup>
  );
}
