"use client"

import { useState } from "react"
import { signIn } from "next-auth/react"
import { useTranslations } from "next-intl"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Loader2 } from "lucide-react"

const STAREDGE_LOGO = "https://img.shingyu.cn/acc/favicon.webp"

export function LoginForm() {
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()
  const t = useTranslations("auth.loginForm")

  const handleStaredgeLogin = async () => {
    setLoading(true)
    try {
      // StarEdge Account OIDC：首次登录自动注册（由 adapter 创建账号）
      await signIn("staredge", { callbackUrl: "/" })
    } catch {
      toast({
        title: t("toast.loginFailed"),
        description: t("toast.loginFailedDesc"),
        variant: "destructive",
      })
      setLoading(false)
    }
  }

  return (
    <Card className="w-[95%] max-w-md border-2 border-primary/20">
      <CardHeader className="space-y-2">
        <CardTitle className="text-2xl text-center bg-gradient-to-r from-primary to-purple-600 bg-clip-text text-transparent">
          {t("title")}
        </CardTitle>
        <CardDescription className="text-center">
          {t("subtitle")}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-6">
        <Button
          className="w-full"
          onClick={handleStaredgeLogin}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={STAREDGE_LOGO}
              alt="StarEdge Account"
              className="mr-2 h-4 w-4 rounded-sm"
            />
          )}
          {t("actions.staredgeLogin")}
        </Button>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t("autoRegisterHint")}
        </p>
      </CardContent>
    </Card>
  )
}
