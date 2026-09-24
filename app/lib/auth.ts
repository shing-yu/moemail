import NextAuth from "next-auth"
import { DrizzleAdapter } from "@auth/drizzle-adapter"
import { createDb, Db } from "./db"
import { accounts, users, roles, userRoles } from "./schema"
import { eq } from "drizzle-orm"
import { getRequestContext } from "@cloudflare/next-on-pages"
import { Permission, hasPermission, ROLES, Role } from "./permissions"
import { generateAvatarUrl } from "./avatar"
import { getUserId } from "./apiKey"

// StarEdge Account（Logto）OIDC 接入
// 发现文档: https://account.o3.hk/oidc/.well-known/openid-configuration
export const STAREDGE_ISSUER = "https://account.o3.hk/oidc"
export const STAREDGE_LOGO = "https://img.shingyu.cn/acc/favicon.webp"
const STAREDGE_SCOPE = "openid offline_access profile email urn:logto:scope:organizations"

/**
 * 读取环境变量：Cloudflare Pages 运行时优先从 request context 读取，
 * 本地开发回退到 process.env。
 */
export function getEnv(name: string): string | undefined {
  try {
    const env = getRequestContext().env as unknown as Record<string, unknown>
    const value = env[name]
    if (typeof value === "string" && value.trim()) return value
  } catch {
    // 非 Cloudflare 运行时
  }

  const value = process.env[name]
  return value && value.trim() ? value : undefined
}

interface StarEdgeProfile {
  sub: string
  name?: string
  username?: string
  preferred_username?: string
  email?: string
  picture?: string
  organizations?: string[]
}

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  [ROLES.EMPEROR]: "皇帝（网站所有者）",
  [ROLES.DUKE]: "公爵（超级用户）",
  [ROLES.KNIGHT]: "骑士（高级用户）",
  [ROLES.CIVILIAN]: "平民（普通用户）",
}

async function findOrCreateRole(db: Db, roleName: Role) {
  let role = await db.query.roles.findFirst({
    where: eq(roles.name, roleName),
  })

  if (!role) {
    const [newRole] = await db.insert(roles)
      .values({
        name: roleName,
        description: ROLE_DESCRIPTIONS[roleName],
      })
      .returning()
    role = newRole
  }

  return role
}

export async function assignRoleToUser(db: Db, userId: string, roleId: string) {
  await db.delete(userRoles)
    .where(eq(userRoles.userId, userId))

  await db.insert(userRoles)
    .values({
      userId,
      roleId,
    })
}

export async function getUserRole(userId: string) {
  const db = createDb()
  const userRoleRecords = await db.query.userRoles.findMany({
    where: eq(userRoles.userId, userId),
    with: { role: true },
  })
  return userRoleRecords[0].role.name
}

export async function checkPermission(permission: Permission) {
  const userId = await getUserId()

  if (!userId) return false

  const db = createDb()
  const userRoleRecords = await db.query.userRoles.findMany({
    where: eq(userRoles.userId, userId),
    with: { role: true },
  })

  const userRoleNames = userRoleRecords.map(ur => ur.role.name)
  return hasPermission(userRoleNames as Role[], permission)
}

/**
 * 根据 StarEdge Account（Logto）OIDC 信息决定角色：
 * - `urn:logto:scope:organizations` 声明中包含 STAREDGE_DUKE_ORGANIZATION_ID → 公爵
 * - 其余 → 平民
 * 皇帝由第一个完成初始化（/api/roles/init-emperor）的用户获得；
 * 公爵/平民遵守管理员面板中设置的限制；面板手动授予的皇帝/骑士身份保持不变。
 */
async function syncRoleOnSignIn(
  userId: string,
  profile: StarEdgeProfile | undefined,
) {
  const db = createDb()

  const existing = await db.query.userRoles.findFirst({
    where: eq(userRoles.userId, userId),
    with: { role: true },
  })
  const currentRoleName = existing?.role?.name

  // 保留皇帝/骑士身份（皇帝来自初始化登基，骑士由管理员面板授予）
  if (currentRoleName === ROLES.EMPEROR || currentRoleName === ROLES.KNIGHT) {
    return
  }

  const dukeOrganizationId = getEnv("STAREDGE_DUKE_ORGANIZATION_ID")
  const isDuke = Boolean(
    dukeOrganizationId &&
    Array.isArray(profile?.organizations) &&
    profile!.organizations!.some((org) => String(org) === dukeOrganizationId)
  )

  const oidcRole = isDuke ? ROLES.DUKE : ROLES.CIVILIAN
  if (currentRoleName !== oidcRole) {
    const role = await findOrCreateRole(db, oidcRole)
    await assignRoleToUser(db, userId, role.id)
  }
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut
} = NextAuth(() => ({
  secret: getEnv("AUTH_SECRET"),
  adapter: DrizzleAdapter(createDb(), {
    usersTable: users,
    accountsTable: accounts,
  }),
  providers: [
    {
      id: "staredge",
      name: "StarEdge Account",
      type: "oidc",
      issuer: getEnv("STAREDGE_ISSUER") || STAREDGE_ISSUER,
      clientId: getEnv("STAREDGE_CLIENT_ID"),
      clientSecret: getEnv("STAREDGE_CLIENT_SECRET"),
      checks: ["pkce", "state"],
      // 从 userinfo 端点获取 profile，以确保拿到 organizations 声明
      //（urn:logto:scope:organizations 授予时，Logto 会在 userinfo 中返回 organizations 数组）
      idToken: false,
      authorization: {
        params: {
          scope: STAREDGE_SCOPE,
        },
      },
      profile(profile: StarEdgeProfile) {
        const name = profile.name ?? profile.username ?? profile.preferred_username
        return {
          id: profile.sub,
          name,
          username: profile.username ?? profile.preferred_username,
          email: profile.email,
          // 无头像时由 jwt 回调生成首字母头像
          image: profile.picture,
        }
      },
    },
  ],
  events: {
    async signIn({ user, account, profile }) {
      if (!user.id) return
      if (account?.provider !== "staredge") return

      try {
        await syncRoleOnSignIn(
          user.id,
          profile as StarEdgeProfile | undefined,
        )
      } catch (error) {
        console.error('Error assigning role:', error)
      }
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.name = user.name || user.username
        token.username = user.username
        token.image = user.image || generateAvatarUrl(token.name as string)
      }
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.name = token.name as string
        session.user.username = token.username as string
        session.user.image = token.image as string

        const db = createDb()
        let userRoleRecords = await db.query.userRoles.findMany({
          where: eq(userRoles.userId, session.user.id),
          with: { role: true },
        })

        if (!userRoleRecords.length) {
          // 兜底：登入时未成功分配角色（例如 signIn 事件失败），按平民处理
          const role = await findOrCreateRole(db, ROLES.CIVILIAN)
          await assignRoleToUser(db, session.user.id, role.id)
          userRoleRecords = [{
            userId: session.user.id,
            roleId: role.id,
            createdAt: new Date(),
            role: role
          }]
        }

        session.user.roles = userRoleRecords.map(ur => ({
          name: ur.role.name,
        }))

        const userAccounts = await db.query.accounts.findMany({
          where: eq(accounts.userId, session.user.id),
        })

        session.user.providers = userAccounts.map(account => account.provider)
      }

      return session
    },
  },
  session: {
    strategy: "jwt",
  },
}))
