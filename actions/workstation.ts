"use server"

import { eq } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { z } from "zod"

import { db } from "@/db"
import { agents } from "@/db/schema"

import { ensureEngine, probeEngine } from "@/lib/docker"
import {
  checkWorkstationNetwork,
  ensureWorkstation,
  getDesktopAccess,
  getWorkstationStatus,
  resetWorkstation,
  stopWorkstation,
} from "@/lib/workstation"
import { buildImage, getImageState } from "@/lib/workstation-image"

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Container names are built from the id, so it has to be a real agent's
function knownAgent(agentId: unknown) {
  const id = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .parse(agentId)
  if (!db.select({ id: agents.id }).from(agents).where(eq(agents.id, id)).get()) {
    throw new Error("Agent not found")
  }
  return id
}

export async function workstationStatus(agentId: string) {
  try {
    return { ok: true as const, status: await getWorkstationStatus(knownAgent(agentId)) }
  } catch (error) {
    return { ok: false as const, error: reason(error) }
  }
}

export async function bootWorkstation(agentId: string) {
  agentId = knownAgent(agentId)
  await ensureWorkstation(agentId)
  return getWorkstationStatus(agentId)
}

export async function haltWorkstation(agentId: string) {
  agentId = knownAgent(agentId)
  await stopWorkstation(agentId)
  return getWorkstationStatus(agentId)
}

export async function wipeWorkstation(agentId: string) {
  agentId = knownAgent(agentId)
  await resetWorkstation(agentId)
  return getWorkstationStatus(agentId)
}

export async function workstationNetwork(agentId: string) {
  try {
    return { ok: true as const, ...(await checkWorkstationNetwork(knownAgent(agentId))) }
  } catch (error) {
    return { ok: false as const, error: reason(error) }
  }
}

// Where the desktop viewer connects, and the desktop's password
export async function desktopAccess(agentId: string) {
  return getDesktopAccess(knownAgent(agentId))
}

/* Docker and the workstation image, for Settings */

export async function dockerStatus() {
  const engine = await probeEngine()
  const image = engine.state === "ready" ? await getImageState() : null
  return { engine, image, platform: process.platform }
}

export async function startDocker() {
  try {
    await ensureEngine()
    revalidatePath("/", "layout")
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, error: reason(error) }
  }
}

// Starts a build and returns right away; progress comes from dockerStatus()
export async function buildWorkstationImage() {
  buildImage().catch((error) =>
    console.error("[xiryn] workstation image build failed:", error)
  )
  return dockerStatus()
}
