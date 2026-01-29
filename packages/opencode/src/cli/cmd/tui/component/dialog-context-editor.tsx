import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createMemo, createSignal, onMount } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { useKV } from "@tui/context/kv"
import type { Part } from "@opencode-ai/sdk/v2"

type ContextItem = {
  messageID: string
  messageRole: "user" | "assistant"
  messageIndex: number
  partID: string
  partType: string
  size: number
  description: string
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
 * Get description and size for a message part
 * @param part - The message part to describe
 * @returns Object containing size in bytes and human-readable description
 */
function getPartDescription(part: Part): { size: number; description: string } {
  let size = 0
  let description = ""

  switch (part.type) {
    case "text":
      size = part.text?.length || 0
      description = part.synthetic
        ? `Synthetic text (${formatBytes(size)})`
        : part.ignored
          ? `Ignored text (${formatBytes(size)})`
          : `Text (${formatBytes(size)})`
      break
    case "file":
      // For data URIs (like base64 images), use the URL length as an approximation
      // For file:// URLs, the URL itself is small but represents potentially large content
      if (part.url?.startsWith("data:")) {
        size = part.url.length
      } else {
        size = 0
      }
      const isImage = part.mime?.startsWith("image/")
      const fileType = isImage ? "🖼️ Image" : "📄 File"

      // Show mime type for images to help identify vision-related attachments
      const mimeInfo = isImage ? ` [${part.mime}]` : ""

      if (size > 0) {
        description = `${fileType}: ${part.filename || "unknown"}${mimeInfo} (${formatBytes(size)})`
      } else {
        description = `${fileType}: ${part.filename || "unknown"}${mimeInfo}`
      }
      break
    case "tool":
      if (part.state?.status === "completed") {
        size = part.state.output?.length || 0
        description = `🔧 Tool: ${part.tool} output (${formatBytes(size)})`
      } else {
        description = `🔧 Tool: ${part.tool} (${part.state?.status || "unknown"})`
      }
      break
    case "reasoning":
      size = part.text?.length || 0
      description = `💭 Reasoning (${formatBytes(size)})`
      break
    case "patch":
      description = `📝 Patch: ${part.files?.length || 0} files`
      break
    case "agent":
      description = `🤖 Agent reference: ${part.name}`
      break
    case "subtask":
      description = `📋 Subtask: ${part.agent} - ${part.description}`
      break
    default:
      description = `${part.type}`
  }

  return { size, description }
}

/**
 * Dialog component for managing session context
 * Allows users to view and delete individual message parts (images, files, tool outputs, etc.)
 * to resolve context issues like token limits or vision model incompatibility
 *
 * @param props.sessionID - The session ID to manage context for
 */
export function DialogContextEditor(props: { sessionID: string }) {
  const sdk = useSDK()
  const toast = useToast()
  const sync = useSync()
  const dialog = useDialog()
  const kv = useKV()

  const [deleted, setDeleted] = createSignal<Set<string>>(new Set())
  const [deleting, setDeleting] = createSignal<Set<string>>(new Set())
  const [dontAskAgain, setDontAskAgain] = kv.signal<boolean>("context_editor_dont_confirm", false)

  onMount(() => {
    dialog.setSize("large")
  })

  const messages = createMemo(() => {
    return sync.data.message[props.sessionID] ?? []
  })

  const contextItems = createMemo((): ContextItem[] => {
    const items: ContextItem[] = []
    const deletedSet = deleted()
    const msgs = messages()

    // Process messages from last to first (reverse order)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      const parts = sync.data.part[msg.id] ?? []

      // Extract token information from assistant messages
      const tokens =
        msg.role === "assistant"
          ? {
              input: msg.tokens?.input || 0,
              output: msg.tokens?.output || 0,
              reasoning: msg.tokens?.reasoning || 0,
            }
          : undefined

      for (const part of parts) {
        if (deletedSet.has(part.id)) continue

        const { size, description } = getPartDescription(part)

        items.push({
          messageID: msg.id,
          messageRole: msg.role,
          messageIndex: i + 1,
          partID: part.id,
          partType: part.type,
          size,
          description,
          tokens,
        })
      }
    }

    return items
  })

  const totalSize = createMemo(() => {
    return contextItems().reduce((sum, item) => sum + item.size, 0)
  })

  const totalTokens = createMemo(() => {
    const seen = new Set<string>()
    let total = 0
    for (const item of contextItems()) {
      if (item.tokens && !seen.has(item.messageID)) {
        seen.add(item.messageID)
        total += item.tokens.input + item.tokens.output + item.tokens.reasoning
      }
    }
    return total
  })

  const options = createMemo((): DialogSelectOption[] => {
    const items = contextItems()
    const deletingSet = deleting()

    if (items.length === 0) {
      return [
        {
          title: "No context items found",
          value: "empty",
          disabled: true,
          description: "This session doesn't have any message parts to manage",
        },
      ]
    }

    // Group items by message
    const groupedByMessage = new Map<string, ContextItem[]>()
    for (const item of items) {
      const key = `${item.messageIndex}-${item.messageID}`
      if (!groupedByMessage.has(key)) {
        groupedByMessage.set(key, [])
      }
      groupedByMessage.get(key)!.push(item)
    }

    // Sort messages by index (newest first, already reversed in contextItems)
    const sortedMessages = Array.from(groupedByMessage.entries()).sort(
      ([keyA], [keyB]) => Number.parseInt(keyB.split("-")[0]) - Number.parseInt(keyA.split("-")[0]),
    )

    // Build options with message-level summaries
    const result: DialogSelectOption[] = [
      {
        title: `Total: ${formatBytes(totalSize())}${totalTokens() > 0 ? ` • ${totalTokens().toLocaleString()} tokens` : ""}`,
        value: "header",
        disabled: true,
        category: "Summary",
      },
    ]

    for (const [key, messageItems] of sortedMessages) {
      const firstItem = messageItems[0]
      const messageRole = firstItem.messageRole
      const messageIndex = firstItem.messageIndex

      // Build category title with token info
      let categoryTitle = `Message ${messageIndex} (${messageRole})`
      if (firstItem.tokens) {
        const totalTokens = firstItem.tokens.input + firstItem.tokens.output + firstItem.tokens.reasoning
        if (totalTokens > 0) {
          categoryTitle += ` • ${totalTokens.toLocaleString()} tokens`
          const tokenParts = []
          if (firstItem.tokens.input > 0) tokenParts.push(`${firstItem.tokens.input.toLocaleString()} in`)
          if (firstItem.tokens.output > 0) tokenParts.push(`${firstItem.tokens.output.toLocaleString()} out`)
          if (firstItem.tokens.reasoning > 0) tokenParts.push(`${firstItem.tokens.reasoning.toLocaleString()} thinking`)
          if (tokenParts.length > 0) {
            categoryTitle += ` (${tokenParts.join(", ")})`
          }
        }
      }

      // Add all items from this message
      for (const item of messageItems) {
        const isDeleting = deletingSet.has(item.partID)
        const isDeleted = deleted().has(item.partID)

        result.push({
          title: isDeleting ? `⏳ ${item.description}` : isDeleted ? `✓ ${item.description}` : item.description,
          value: item.partID,
          category: categoryTitle,
          footer: isDeleting ? "Deleting..." : isDeleted ? "Removed" : "Press Enter to remove",
          disabled: isDeleting || isDeleted,
          onSelect: async () => {
            // Check if user wants confirmation
            const shouldConfirm = !dontAskAgain()

            if (shouldConfirm) {
              const confirmed = await DialogConfirm.show(
                dialog,
                "Remove Context Item",
                `Are you sure you want to remove this item?\n\n${item.description}\n\nThis action cannot be undone.`,
              )

              if (!confirmed) {
                return
              }

              // Show option to not ask again
              const dontAsk = await DialogConfirm.show(
                dialog,
                "Confirmation Preference",
                "Don't ask for confirmation when removing context items in the future?",
              )

              if (dontAsk) {
                setDontAskAgain(() => true)
              }

              // Re-show the context editor after confirmation dialogs
              dialog.replace(() => <DialogContextEditor sessionID={props.sessionID} />)
            }

            // Start deletion
            setDeleting((prev) => new Set(prev).add(item.partID))

            try {
              await sdk.client.part.delete({
                sessionID: props.sessionID,
                messageID: item.messageID,
                partID: item.partID,
              })

              setDeleted((prev) => new Set(prev).add(item.partID))
              toast.show({ message: "Part removed from context", variant: "success" })

              // Check if this was the last part in the message
              const allParts = sync.data.part[item.messageID] ?? []
              const remainingParts = allParts.filter((p) => !deleted().has(p.id) && p.id !== item.partID)

              if (remainingParts.length === 0) {
                // All parts deleted - revert to this message to remove it completely
                try {
                  await sdk.client.session.revert({
                    sessionID: props.sessionID,
                    messageID: item.messageID,
                  })
                  toast.show({ message: "Message removed (all parts deleted)", variant: "success" })
                } catch (error) {
                  const errorMsg = error instanceof Error ? error.message : "Unknown error"
                  toast.show({ message: `Warning: Could not remove empty message: ${errorMsg}`, variant: "warning" })
                }
              }
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : "Unknown error"
              toast.show({ message: `Failed to remove part: ${errorMsg}`, variant: "error" })
            } finally {
              setDeleting((prev) => {
                const next = new Set(prev)
                next.delete(item.partID)
                return next
              })
            }
          },
        })
      }
    }

    return result
  })

  return <DialogSelect title="Edit Session Context" options={options()} placeholder="Select an item to remove" />
}
