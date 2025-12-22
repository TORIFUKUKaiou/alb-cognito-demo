# ALB + Cognito認証 + CloudFront 最小構成デモ

## 構成

```
CloudFront ─┬→ / (S3: フロントエンド)
            └→ /api/* (ALB → EC2)
                 ↓
            カスタムヘッダー検証
```

## セキュリティ

1. **CloudFront → ALB**: カスタムヘッダー（`X-Custom-Secret`）で検証
   - ALBに直接アクセスしても403 Forbidden
2. **EC2**: JWT検証（Cognitoトークン必須）

## 認証フロー

```mermaid
sequenceDiagram
    participant Browser as ブラウザ
    participant CloudFront
    participant Cognito
    participant ALB
    participant EC2

    Browser->>CloudFront: 1. GET / (フロントエンド)
    CloudFront->>Browser: 2. HTML/JS返却
    Browser->>Cognito: 3. ログイン（Hosted UI）
    Cognito->>Browser: 4. IDトークン返却
    Browser->>CloudFront: 5. GET /api/?wait=5 (Authorization: Bearer token)
    CloudFront->>ALB: 6. 転送 + X-Custom-Secret ヘッダー付与
    ALB->>ALB: 7. ヘッダー検証
    ALB->>EC2: 8. 転送
    EC2->>EC2: 9. JWT検証
    EC2->>Browser: 10. レスポンス
```

## デプロイ手順

```bash
git clone https://github.com/TORIFUKUKaiou/alb-cognito-demo.git
cd alb-cognito-demo
npm install
npx cdk bootstrap  # 初回のみ
npx cdk deploy
```

## テスト手順

1. `CloudFrontUrl` にアクセス
2. Cognito Domain と Client ID を入力
3. 「Login with Cognito」でログイン
4. 「Call API」でAPI呼び出し

### ALB直接アクセスの確認

```bash
curl http://<AlbDns>/
# → {"error": "Forbidden"} (403)
```

CloudFront経由でないとアクセス不可。

## 3分待機テスト

「Call API (3min)」ボタンで180秒待機テスト。

## 削除

```bash
npx cdk destroy
```
