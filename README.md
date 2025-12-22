# ALB + Cognito認証 + CloudFront 最小構成デモ

## 構成
```
CloudFront (HTML/JS) → ブラウザ → ALB (Cognito認証) → EC2
```

## デプロイ
```bash
cd /Users/yamauchi/repos/alb-cognito-demo
npx cdk bootstrap  # 初回のみ
npx cdk deploy
```

## テスト手順
1. 出力された `AlbDns` に直接アクセス → Cognito認証（ユーザー登録/ログイン）
2. `CloudFrontUrl` にアクセス
3. ALB URLを入力してAPIコール

## 3分待機テスト
「Call API (3min)」ボタンで180秒待機テスト

## 削除
```bash
npx cdk destroy
```
