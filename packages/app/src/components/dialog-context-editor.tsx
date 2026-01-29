import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useParams } from "@solidjs/router"
import { createMemo, createSignal, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import type { Part } from "@opencode-ai/sdk/v2/client"

type ContextItem = {
  messageID: string
  messageRole: "user" | "assistant"
  messageIndex: number
  partID: string
  partType: string
  size: number
  description: string
  icon: string
  tokens?: {
    input: number
    output: number
    reasoning: number
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i]
}

/**
 * Get description, size, and icon for a message part
 * @param part - The message part to describe
 * @returns Object containing size in bytes, human-readable description, and emoji icon
 */
function getPartInfo(part: Part): { size: number; description: string; icon: string } {
  let size = 0
  let description = ""
  let icon = "📄"

  switch (part.type) {
    case "text":
      size = part.text?.length || 0
      description = part.synthetic
        ? `Synthetic text (${formatBytes(size)})`
        : part.ignored
          ? `Ignored text (${formatBytes(size)})`
          : `Text (${formatBytes(size)})`
      icon = "💬"
      break
    case "file":
      if (part.url?.startsWith("data:")) {
        size = part.url.length
      }
      const isImage = part.mime?.startsWith("image/")
      icon = isImage ? "🖼️" : "📄"
      const mimeInfo = isImage ? ` [${part.mime}]` : ""
      if (size > 0) {
        description = `${part.filename || "unknown"}${mimeInfo} (${formatBytes(size)})`
      } else {
        description = `${part.filename || "unknown"}${mimeInfo}`
      }
      break
    case "tool":
      icon = "🔧"
      if (part.state?.status === "completed") {
        size = part.state.output?.length || 0
        description = `${part.tool} output (${formatBytes(size)})`
      } else {
        description = `${part.tool} (${part.state?.status || "unknown"})`
      }
      break
    case "reasoning":
      icon = "💭"
      size = part.text?.length || 0
      description = `Reasoning (${formatBytes(size)})`
      break
    case "patch":
      icon = "📝"
      description = `Patch: ${part.files?.length || 0} files`
      break
    case "agent":
      icon = "🤖"
      description = `Agent: ${part.name}`
      break
    case "subtask":
      icon = "📋"
      description = `${part.agent} - ${part.description}`
      break
    default:
      description = `${part.type}`
  }

  return { size, description, icon }
}

/**
 * Dialog component for managing session context in web app
 * Allows users to view and delete individual message parts
 */
export function DialogContextEditor() {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const params = useParams()

  const [deleted, setDeleted] = createSignal<Set<string>>(new Set())
  const [deleting, setDeleting] = createSignal<Set<string>>(new Set())

  const items = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return []

    const messages = sync.data.message[sessionID] ?? []
    const result: ContextItem[] = []

    // Process messages in reverse order (newest first)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const parts = (sync.data.part[msg.id] ?? []) as Part[]

      for (const part of parts) {
        const info = getPartInfo(part)
        result.push({
          messageID: msg.id,
          messageRole: msg.role,
          messageIndex: i,
          partID: part.id,
          partType: part.type,
          size: info.size,
          description: info.description,
          icon: info.icon,
          tokens: msg.role === "assistant" ? msg.tokens : undefined,
        })
      }
    }

    return result
  })

  const handleDelete = async (item: ContextItem) => {
    const sessionID = params.id
    if (!sessionID) return

    const confirmed = confirm(`Remove this item?\n\n${item.description}\n\nThis cannot be undone.`)
    if (!confirmed) return

    setDeleting((prev) => new Set(prev).add(item.partID))

    try {
      await sdk.client.part.delete({
        sessionID,
        messageID: item.messageID,
        partID: item.partID,
      })

      setDeleted((prev) => new Set(prev).add(item.partID))
      showToast({ description: "Part removed from context", variant: "success" })

      // Check if this was the last part in the message
      const allParts = sync.data.part[item.messageID] ?? []
      const remainingParts = allParts.filter((p) => !deleted().has(p.id) && p.id !== item.partID)

      if (remainingParts.length === 0) {
        try {
          await sdk.client.session.revert({
            sessionID,
            messageID: item.messageID,
          })
          showToast({ description: "Message removed (all parts deleted)", variant: "success" })
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error"
          showToast({ description: `Could not remove empty message: ${errorMsg}`, variant: "error" })
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error"
      showToast({ description: `Failed to remove part: ${errorMsg}`, variant: "error" })
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev)
        next.delete(item.partID)
        return next
      })
    }
  }

  return (
    <Dialog title="Edit Session Context">
      <List
        search={{ placeholder: "Search context items", autofocus: true }}
        emptyMessage="No context items found"
        items={() => items()}
        key={(x) => x.partID}
        onSelect={(item) => {
          if (item && !deleted().has(item.partID) && !deleting().has(item.partID)) {
            handleDelete(item)
          }
        }}
      >
        {(item) => {
          const isDeleting = deleting().has(item.partID)
          const isDeleted = deleted().has(item.partID)

          return (
            <div class="w-full flex items-center justify-between gap-3 rounded-md">
              <div class="flex items-center gap-x-3 grow min-w-0">
                <span class="text-16">{item.icon}</span>
                <div class="flex flex-col min-w-0">
                  <div class="text-14-regular text-text-strong truncate">{item.description}</div>
                  <div class="text-12-regular text-text-weak">
                    {item.messageRole} message #{item.messageIndex + 1}
                    <Show when={item.tokens}>
                      {" • "}
                      {(item.tokens!.input + item.tokens!.output + item.tokens!.reasoning).toLocaleString()} tokens
                    </Show>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Show when={isDeleting}>
                  <span class="text-12-regular text-text-weak">Deleting...</span>
                </Show>
                <Show when={isDeleted}>
                  <span class="text-12-regular text-text-success">✓ Removed</span>
                </Show>
                <Show when={!isDeleting && !isDeleted}>
                  <IconButton
                    icon="close"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(item)
                    }}
                  />
                </Show>
              </div>
            </div>
          )
        }}
      </List>
    </Dialog>
  )
}
