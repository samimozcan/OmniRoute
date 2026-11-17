# Sonraki kararlı sürüm için Terra ve Cmd+K TODO

Durum: **TODO / Draft — uygulama ve yayın beklemede.**

17 Kasım 2026 tarihli karar: yeni kararlı upstream release yayımlandıktan sonra,
kullanıcı aynı sohbet oturumundan devam ettiğinde Terra ve Cmd+K davranışlarını
kontrol et. Upstream'in karşıladığı patch'leri tekrar ekleme; yalnızca eksik veya
kısmen karşılanan davranışları taşı. Ardından yeni sürüm tabanında doğrulanmış bir
image üret. Bu kayıt tek başına rebase, build, yayın veya canlı geçiş başlatmaz.

## Başlangıç ve geri dönüş referansı

- Mevcut Terra/Cmd+K çalışması: [fork PR #3](https://github.com/samimozcan/OmniRoute/pull/3).
- Korunacak kaynak dalı: `feat/v3.8.53-terra-cmdk`.
- Not oluşturulurken doğrulanan dal ucu: `ce57802a69b8f2669f7ce946847c5bb406b7d79e`.
- PR #3'te kayıtlı upstream tabanı: `v3.8.53`, commit `191dce8d534ceb56c28a08e71381284a9a87838f`.
- PR #3'te kayıtlı yayımlanmış image: `ghcr.io/samimozcan/omniroute:3.8.53-terra-cmdk-ce57802a69b8`.
- PR #3'te kayıtlı manifest: `sha256:9908557122bf681e5a0523da75f5cf28fcfa745595c2b7c1c137336d75cdcbf1`.

Bu referans, canlı sunucuda hangi image'ın çalıştığına dair bir tespit değildir.
Mevcut sabit etiket/digest ve veri korunacak; yeni image doğrulanmadan eski image
silinmeyecek ve hareketli etiketler ilerletilmeyecek.

## Release geldiğinde kontrol

- [ ] Yayımlanmış en güncel kararlı upstream release'i doğrula; sürüm, release URL'si, tag ve gerçek commit SHA'sını bu PR'ye kaydet.
- [ ] Açık/merge edilmiş bir release PR'sini veya hareketli release dalını tek başına yayımlanmış sürüm sayma. [Upstream #19191](https://github.com/cheaper-inference/OmniRoute/pull/19191) yalnızca takip referansıdır; hedef sürüm devam anında belirlenecek.
- [ ] Fork PR #3'ün güncel durumunu ve bu TODO'yu yeniden oku; başka oturumun değişikliklerinin üzerine yazma.
- [ ] Terra ve Cmd+K için changelog adına değil, hedef tag'in gerçek koduna ve davranış testlerine göre ayrı ayrı karar ver.

## Terra kabul ölçütleri

Buradaki Terra, tema değil, native OpenAI Chat istek-parametresi uyumluluğu
patch'idir. Tarihsel kaynak: [fork PR #1](https://github.com/samimozcan/OmniRoute/pull/1)
ve bunun v3.8.53'e taşındığı PR #3.

- [ ] Native OpenAI Chat sınırında router'a özgü `effort`, `thinking` ve Responses biçimindeki iç içe `reasoning` alanları doğru normalize ediliyor; geçerli `reasoning_effort` ve açık öncelik kuralları korunuyor.
- [ ] Thinking kapatma/açma ve desteklenen object/budget biçimlerinin niyeti kaybolmuyor; düzeltme yalnızca bir sonraki retry/fallback başarısıyla gizlenmiyor.
- [ ] Doğrudan ve priority-combo çağrılarının gerçekten serileştirilen upstream gövdeleri kontrol ediliyor; OpenAI Responses, OpenRouter ve Anthropic sözleşmeleri bozulmuyor.
- [ ] Mevcut `tests/unit/openai-canonical-effort-18912.test.ts` testlerinin kapsadığı davranışlar hedef upstream üzerinde değerlendirilip sonuçları kaydediliyor.

Başlangıç kaynakları: `open-sse/translator/helpers/openaiHelper.ts` ve
`open-sse/translator/index.ts`. Hedef sürümde dosyalar taşınmışsa eşdeğer çağrı
yolunu bul; eski dosya adının yokluğunu tek başına fix yokluğu sayma.

## Cmd+K kabul ölçütleri

Sadece komut paletinin veya metin eşleşmesine göre sıralamanın bulunması yeterli
değildir. Korunacak özel davranış PR #3'teki isteğe bağlı **Most used first**
kullanım-sıklığı sıralamasıdır.

- [ ] Özellik varsayılan olarak kapalı; tercih ve sınırlı kullanım geçmişi aynı tarayıcıda korunuyor.
- [ ] Açıkken sorguyla eşleşen komutlar önce kullanım sayısı, sonra eşleşme kalitesi, sonra özgün sıraya göre sıralanıyor. Eşleşmeyen komutlar, sayıları yüksek olsa bile listeye girmiyor.
- [ ] PR #3'teki `quo` / `quota` regresyonu dahil: daha çok kullanılan Provider Quota, yalnızca daha iyi prefix eşleşmesine sahip Quota Sharing'in gerisine düşmüyor.
- [ ] Fare ve Enter ile gerçekten çalıştırılan seçim aynı sayacı tam bir kez artırıyor; sorguyu silip yeniden yazma ve aktif seçenek davranışı korunuyor.
- [ ] Kapalı/geçmişsiz kullanım, gizli komutlar ve erişilemeyen/bozuk tarayıcı depolaması güvenli davranıyor.
- [ ] `tests/unit/ui/command-palette-frequency.test.tsx` davranışları hedef sürümde doğrulanıp sonuçları kaydediliyor.

Başlangıç kaynakları: `src/shared/components/CommandPalette.tsx` ve
`src/shared/utils/commandPalettePreferences.ts`.

## Patch kararı ve yeni image

| Hedef upstream durumu | Yapılacak işlem |
| --- | --- |
| Terra ve Cmd+K davranışları tam karşılanıyor | Yeni kararlı sürüme geç/rebase et; eşdeğer yerel patch'leri düşür, çift uygulama yapma. |
| Yalnızca biri tam karşılanıyor | Karşılanan patch'i düşür; yalnızca diğerinin eksik davranışını taşı. |
| Biri veya ikisi kısmen karşılanıyor | Kanıtlanan eksik davranışlar için en küçük uyarlamayı yap; ilgili regresyon testlerini koru. |
| İkisi de karşılanmıyor | Mevcut Terra ve Cmd+K davranışlarını yeni tabana uyarlayarak tekrar uygula. |

- [ ] Kararı her patch için kod/commit ve test kanıtıyla PR'ye yaz; mevcut geri dönüş dalını koruyan izole bir entegrasyon dalında rebase/geçiş yap. PR tabanını yeni hedefle tutarlı hale getir.
- [ ] Gerekli regresyonları, tip/lint kontrollerini ve uygulanabilir proje testlerini çalıştır. Çalıştırılmayan, başarısız veya yalnızca fixture ile doğrulanan kontrolleri ayrı belirt; eski sürümün sonuçlarını yeni sürüm için başarı sayma.
- [ ] `.github/workflows/docker-terra-cmdk.yml` içindeki v3.8.53 sürüm ve dal sabitlemelerini yeni hedef için gözden geçir. Eski workflow'u yeni dalda çalışır veya yeni sürüme hazır varsayma.
- [ ] Doğrulanan kaynak SHA'sından `linux/amd64` ve `linux/arm64` image üret; startup ve aynı geçici volume ile restart/kalıcılık kontrollerini yap.
- [ ] Yeni sürüm + kaynak SHA içeren ayrı sabit etiket yayımla; manifest digest, iki mimari ve source revision bilgisini doğrula. Eski sabit etiketi değiştirme.
- [ ] Yeni image, digest ve rollback bilgisini PR'ye kaydet. Canlı kullanım geçişini ayrıca ele al; yayın yapılmış olmasını deploy yapılmış gibi sunma.

## İptal edilen çalışmalar ve devam sınırı

[PR #4 iptal kaydı](https://github.com/samimozcan/OmniRoute/pull/4#issuecomment-6942991317)
geçerlidir. `feat/provider-file-cache-routing` dalını geçiş tabanı yapma; iptal
edilen native dosya/cache patch'lerini veya publisher workflow'larını yeniden
taşıma. [PR #2](https://github.com/samimozcan/OmniRoute/pull/2) ile geri çekilmiş
özel OpenAI usage/Admin raporlama çalışmasını da yeniden ekleme.

Yeni release'in kendi yerleşik özellikleri, iptal edilmiş fork patch'lerini
bilerek geri taşımakla aynı şey değildir; kapsam dışı ürün değişiklikleri yapma.
RelayHub veya canlı ortam ayarlarını bu TODO kapsamında değiştirme.

Bu oturumdaki değişiklik yalnızca bu takip notudur. Yeni sürüm denetimi, rebase,
patch uygulama, test/build, image yayını ve deployment görevleri henüz yapılmadı.
PR Draft/TODO olarak kalacak; sonraki çalışma kullanıcı bu sohbetten devam
ettiğinde bu kayıt ve güncel remote durum okunarak başlayacak.
