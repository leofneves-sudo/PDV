# Last Place PDV

PDV local para loja física, com atendimento touchscreen, cartões QR reutilizáveis e leitura contínua pelo celular. A instalação começa com o banco vazio. Os cadastros e as vendas são gravados em SQLite.

## Instalar e iniciar

No computador que vai hospedar o PDV, instale o Node.js 24 ou mais recente. Abra o terminal na pasta do projeto.

```sh
npm ci
npm start
```

### Iniciar pela Área de Trabalho no Windows

Execute `npm run atalho` uma vez para criar **Iniciar Last Place PDV** na Área de Trabalho do usuário. Dê dois cliques no atalho para iniciar os servidores do computador e do celular em segundo plano e abrir `http://localhost:3000` no navegador padrão. O iniciador aguarda os dois serviços responderem e reutiliza os que já estiverem ligados. Cliques simultâneos não criam instâncias duplicadas.

O repositório inclui uma cópia do atalho original em [`atalhos/Iniciar Last Place PDV.lnk`](atalhos/Iniciar%20Last%20Place%20PDV.lnk). Esse arquivo aponta para a pasta deste computador. Em outro computador, gere um atalho próprio com `npm run atalho`. Também é possível dar dois cliques em [`Iniciar Last Place PDV.cmd`](Iniciar%20Last%20Place%20PDV.cmd), mantendo esse arquivo na raiz do projeto, junto da pasta `scripts`.

O IP da rede local é identificado automaticamente. Os endereços ficam em `data/inicializador/enderecos.txt`; registros de inicialização e eventuais erros ficam na mesma pasta. O celular deve estar na mesma rede e confiar no certificado público do PDV. O iniciador mantém a verificação dos certificados HTTPS e não encerra processos já existentes. Se mover a pasta do projeto, execute `npm run atalho` novamente depois de remover o atalho antigo.

Também é possível iniciar os dois serviços pelo terminal com `npm run iniciar`. O atalho apenas inicia os serviços quando aberto; ele não configura inicialização automática com o Windows.

### Iniciar com dois cliques no macOS

Depois de instalar as dependências com `npm ci`, dê dois cliques em [Iniciar Last Place PDV.command](Iniciar%20Last%20Place%20PDV.command) pelo Finder. Mantenha o arquivo na raiz do projeto. Ele inicia o servidor do computador e o acesso HTTPS do celular em segundo plano e abre o PDV no navegador padrão quando os dois estiverem disponíveis. Se já estiverem rodando, ele reutiliza os serviços.

O Terminal mostra os endereços do PDV. Você pode fechar a janela depois que o navegador abrir. Se o arquivo perder a permissão de execução ao ser copiado, execute `chmod +x "Iniciar Last Place PDV.command"` na pasta do projeto.

### Configuração inicial

1. Abra `http://localhost:3000` no computador do servidor. Crie o primeiro administrador com uma senha de pelo menos dez caracteres. A criação inicial só está disponível no próprio servidor, usando localhost.
2. Em **Operadores**, crie uma conta individual para cada funcionário. O perfil Operador recebe as permissões de atendimento, pagamento, consulta e cadastro de clientes e histórico do próprio turno. Ajuste as permissões por ação antes de entregar os acessos. Conceda a consulta do extrato de créditos aos operadores que precisarem conferir os lançamentos.
3. Cadastre os produtos com o preço, a categoria e o estoque inicial. Produtos das categorias Alimentação, Alimentos ou Bebidas (inclusive categorias combinadas) exigem uma **data de validade**. A validade aparece na lista de produtos e pode ser atualizada ao editar o cadastro. Produtos existentes são preservados e precisam da data ao serem editados. Use **Movimentar estoque** para entradas e saídas posteriores.
4. Em **Cartões QR**, crie um lote. Use a ação de impressão de uma linha para um cartão ou selecione os cartões e clique em **Imprimir seleção**. Use o diálogo de impressão do navegador para escolher a impressora ou salvar em PDF.

A primeira execução cria `data/pdv.sqlite`. Para mover ou copiar o banco, desligue o servidor e faça backup da pasta de dados inteira, incluindo os arquivos auxiliares do SQLite quando estiverem presentes. Mantenha uma instância do servidor usando esse banco.

| Variável | Padrão e finalidade |
| --- | --- |
| `PDV_HOST` | `127.0.0.1`. Use `0.0.0.0` no serviço HTTPS para aceitar dispositivos da rede local. |
| `PDV_PORT` | `3000`. Porta em que o servidor escuta. |
| `PDV_DB` | `data/pdv.sqlite`. Caminho do banco de dados. |
| `PDV_TIMEZONE` | `America/Sao_Paulo`. Fuso da loja para relatórios e horários exibidos. |
| `PDV_ORIGIN` | Endereço completo acessado pelos dispositivos, incluindo HTTPS e porta, quando aplicável. |
| `PDV_TLS_CERT` e `PDV_TLS_KEY` | Caminhos do certificado e da chave PEM para servir HTTPS diretamente. |

## Acesso pelo celular

Com o PDV já aberto no computador em `http://localhost:3000`, deixe o servidor rodando e abra um segundo terminal na pasta do projeto. O comando funciona no Windows, macOS e Linux e gera os certificados pelo Node.js, sem exigir OpenSSL instalado.

```sh
npm run celular -- IP_DO_COMPUTADOR
```

Use o IP do computador na rede local. O comando imprime o endereço HTTPS na porta `3443` e encaminha as leituras para o mesmo servidor usado pelo caixa. Mantenha os dois processos rodando e conecte o celular à mesma rede.

Transfira `data/https/balcao-ca.cer` do computador para o celular. Esse é o certificado público da autoridade local do PDV. Os arquivos `.key` ficam no computador do servidor.

- **iPhone** — Abra o arquivo recebido por AirDrop e instale o perfil em **Ajustes**. Depois ative a confiança em **Ajustes → Geral → Sobre → Ajustes de Confiança de Certificado**. [Suporte da Apple](https://support.apple.com/pt-br/102390)
- **Android** — Abra **Instalar certificado** nos ajustes de segurança, escolha **Certificado CA** e selecione o arquivo recebido. Os nomes dos menus variam conforme o aparelho.

No celular, abra o endereço HTTPS exibido no terminal e faça login. **O vínculo com o computador é obrigatório antes de usar o sistema.** No computador, abra `http://localhost:3000`, entre na sua conta e clique em **Parear caixa → Gerar código**. Digite os seis números na tela de vinculação do celular. Cada código vale por dois minutos e pode ser usado uma vez.

### Servidor HTTPS direto

1. Conclua a criação do administrador no localhost antes de ativar o acesso pela rede.
2. Escolha um nome de rede ou IP fixo para o servidor. Use um certificado cujo nome ou IP conste no campo SAN e cuja autoridade seja confiável no computador do caixa e nos celulares. Se a loja usa uma autoridade privada, instale e habilite a confiança dessa autoridade nos dispositivos.
3. Inicie o PDV com o certificado e a chave. Substitua o nome e os caminhos do exemplo pelos da loja.

```sh
PDV_HOST=0.0.0.0 PDV_PORT=3443 \
PDV_ORIGIN=https://pdv.loja.test:3443 \
PDV_TLS_CERT=/caminho/certificado.pem \
PDV_TLS_KEY=/caminho/chave.pem npm start
```

4. Permita a porta no firewall da rede da loja. Conecte o celular ao mesmo Wi‑Fi, abra o endereço HTTPS no navegador e confira se o certificado foi aceito. A câmera exige um contexto seguro. A exceção de localhost vale para o computador que hospeda a página. [Documentação da câmera no navegador](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
5. Entre com o usuário do celular, abra **Leitor de QR** e toque em **Ativar câmera**. Autorize o acesso quando o navegador perguntar. Escolha a câmera traseira e use a lanterna quando o aparelho oferecer essa opção. A vibração depende do suporte do navegador.

Se a loja já tiver um proxy HTTPS, mantenha o Node acessível apenas na interface local do servidor, publique a origem HTTPS no proxy e defina `PDV_ORIGIN` com esse endereço. Preserve a transmissão contínua de `/api/events` e desative o buffering do proxy nessa rota.

### Operar no celular ou no caixa

- O celular só libera as telas e as operações depois de ser vinculado a uma sessão válida do computador. O bloqueio também é verificado pelo servidor, inclusive para administradores, acessos pela rede, leitura manual e chamadas diretas à API. Gerar códigos e revogar todos os vínculos são ações do computador pelo localhost. A identificação não depende da largura da tela: reduzir a janela do computador continua permitido.
- Após vincular, leia o cartão no modo **No caixa e neste celular**. Se houver atendimento aberto, ele aparece imediatamente. Para um cartão livre, toque em **Iniciar atendimento**. A câmera continua ativa durante o atendimento até ser desligada ou até você sair das telas de atendimento e leitura. Mantenha o sistema aberto no computador para receber as leituras. A opção **Neste dispositivo** permanece disponível no computador.
- No celular, use **Produtos** para pesquisar, filtrar por categoria e tocar nos itens que deseja adicionar. Use **Comanda** ou **Ver comanda**, na barra inferior, para conferir os itens e alterar quantidades. O número do cartão, a quantidade de itens e o total ficam visíveis durante o atendimento. A confirmação de inclusão informa a comanda que recebeu o produto. Operadores com permissão de atendimento podem adicionar produtos mesmo sem permissão para receber pagamentos.
- **Comandas abertas na loja** mostra o total atual do servidor. **Comanda (N itens)** indica a quantidade de produtos da comanda selecionada, não o número de comandas da loja. As comandas lidas pelo operador ou pelo dispositivo pareado aparecem como cartões para seleção. Ao abrir uma nova aba ou recarregar, o celular recupera as comandas abertas acessíveis no servidor, inclusive as anteriores ao pareamento. Desvincular, revogar o vínculo ou encerrar/expirar a sessão do computador bloqueia o celular novamente, inclusive as comandas já lidas por ele. Para voltar, gere um novo código no computador e vincule novamente.
- O **X** de uma comanda aberta inicia o encerramento. Se estiver vazia, confirme o cancelamento para liberar o cartão. Com produtos, escolha **Receber e fechar** ou **Cancelar atendimento**. Com parcelas registradas, confira os pagamentos antes de concluir; PIX pendente impede o fechamento. Cancelamentos respeitam as permissões e podem exigir aprovação do administrador. O atendimento só sai da lista e do contador quando o servidor confirma o encerramento. O X de um cartão disponível apenas o retira da tela. Comandas abertas que tinham sido ocultadas pela versão anterior voltam a aparecer.
- A tela se adapta de 320 px até tablets e desktops: celulares usam duas colunas de produtos e alternam entre catálogo e comanda; telas maiores mostram os dois painéis lado a lado. Há espaço para as áreas seguras da tela, botões para toque e campos que mantêm o tamanho legível ao abrir o teclado. Se a conexão cair, as inclusões ficam bloqueadas até a reconexão automática, sem reenviar alterações pendentes. Ao voltar ao navegador ou recarregar a página na mesma sessão, a comanda é consultada novamente no servidor.
- Para parear, abra **Parear caixa** no menu ou **Gerar código no caixa** no leitor do computador que vai receber as leituras. Informe o nome do caixa e gere um código. No celular, informe os seis dígitos na tela de vínculo obrigatório em até dois minutos. Depois de vinculado, use **Leitor de QR → Trocar caixa** para escolher outro computador. Cada código dá direito a um vínculo. Mantenha o caixa online. No modo **No caixa e neste celular**, a leitura abre o mesmo cartão nos dois dispositivos. A abertura e as alterações da comanda são sincronizadas, e o celular também pode adicionar produtos conforme as permissões do operador. Use sessões distintas no caixa e no celular. Sair da conta do celular também exige um novo vínculo no próximo login.
- Para usar um leitor externo que emula teclado, foque o campo **Código do cartão** em **Leitor externo**. Configure o leitor para enviar Enter após a leitura.
- Ao bloquear ou trocar o operador, as comandas abertas continuam no servidor. Leia novamente os cartões para retomá-las. O histórico do próprio turno corresponde aos atendimentos encerrados no turno mais recente do operador. Vendas antigas sem turno usam a sessão registrada. Cancelamentos sem turno comprovado usam o operador registrado. O pareamento encerra ao sair da sessão do caixa ou do leitor. O administrador também pode revogar o vínculo pelo caixa.

O QR contém um identificador aleatório do cartão. Para consultar ou operar uma comanda aberta, o servidor exige autenticação, permissão de atendimento e leitura validada para a sessão.

## Vendas, créditos e relatórios

- **Receber pagamento** aceita dinheiro, débito, crédito, PIX e saldo da loja. Informe as parcelas que somam o total. Na parcela em dinheiro, informe o valor entregue. O comprovante não fiscal fica disponível após a confirmação do servidor, com opção de reimpressão pelo histórico.
- O saldo da loja vem do extrato de créditos. As recargas aparecem separadamente no dashboard. O uso do saldo integra os pagamentos da venda. O estorno de venda reverte estoque e saldo da loja em novos lançamentos. Corrigir uma recarga registra o estorno e a recarga correta com referência à original. Para dinheiro e cartões, faça a devolução pelo meio de pagamento usado e registre o estorno no PDV.
- O dashboard compara o intervalo selecionado com a mesma quantidade de dias imediatamente anterior. Filtros de categoria e pagamento selecionam vendas que contêm os valores escolhidos. Cada venda entra uma vez, pelo valor integral. Os indicadores distinguem o bruto na data da venda, as devoluções na data em que ocorreram e o líquido atualizado das vendas originais. Comandas abertas, estoque e créditos disponíveis refletem o estado atual.
- O fechamento registra pagamentos, estoque, consumo de crédito, auditoria e liberação do cartão na mesma transação SQLite. Se a conexão cair, a tela informa o estado e aguarda confirmação. Consulte o comprovante ou o histórico antes de repetir um pagamento registrado na maquininha.
- Dados de cartão são registrados como forma e valor do pagamento. A autorização pela maquininha, quando utilizada, é feita separadamente.


## Atualização operacional

### Caixa e pagamentos

- Em **Caixa e turnos**, escolha um caixa livre e informe o fundo em dinheiro. Registre suprimentos e sangrias pelo mesmo painel. Ao fechar, informe o total físico contado. Uma diferença exige motivo. O administrador pode lançar um ajuste posterior, com o fechamento original preservado.
- Em **Atendimento → Receber pagamento**, informe as parcelas já recebidas. Para dividir entre pessoas, use a sugestão de valor e informe o nome de quem pagou cada parcela. Ao registrar dinheiro, preencha o valor entregue para calcular o troco.
- **Registrar parcela** mantém a comanda aberta. **Fechar comanda** exige saldo quitado e PIX confirmados. Para PIX, registre a parcela pendente, confira o extrato bancário e selecione **Confirmar PIX** com a permissão ou aprovação correspondente. A confirmação vincula a entrada ao turno que a recebeu. As parcelas já confirmadas permanecem no turno original mesmo quando a venda fecha depois.
- Em operações que exigem autorização, o administrador pode preencher o próprio usuário e senha na seção **Autorização do administrador**. A sessão continua no nome do operador. Os dois responsáveis aparecem na auditoria.

### Comandas, devoluções e créditos

- Leia o QR dos cartões de origem e destino. Use **Transferir** para passar itens para uma comanda aberta e **Dividir** para abrir outra em um cartão livre. As parcelas já registradas ficam na origem. O saldo da origem precisa continuar cobrindo essas parcelas. **Unir** exige permissão e leva itens, descontos e parcelas inteiras ao destino. A operação exige o mesmo cliente quando ambos os cartões já estiverem vinculados.
- Em **Histórico → Detalhes → Registrar devolução**, indique produtos, quantidades e quais voltam ao estoque. Para registrar uma troca, selecione também o atendimento aberto que receberá a nova compra. Os valores são rateados entre as formas originais de pagamento, dentro do que ainda pode ser devolvido. O crédito da loja retorna ao extrato. Faça a devolução em dinheiro, cartão ou PIX pelo meio original antes de registrá-la no PDV.
- Em **Clientes → Adicionar crédito**, escolha compra de saldo, bonificação ou ajuste. A entrada em dinheiro pertence ao turno em que foi recebida. Em **Compras e fornecedores → Comprar cartas do cliente**, a entrada de estoque e o crédito ficam ligados e são gravados juntos.
- Em **Cartões QR**, use **Bloquear** para cartões perdidos e **Substituir QR** para gerar outro código no mesmo cartão. Imprima o código novo. O acesso por número exige permissão e motivo.

### Controle de validade por produto

- **Produtos** e **Visão geral** mostram produtos vencidos, que vencem hoje, em 1 a 7 dias, em 8 a 30 dias e alimentos ou bebidas sem validade. Os totais consideram o estoque físico atual, incluindo reservas e produtos inativos, independentemente do período financeiro selecionado. Clique numa faixa para filtrar os produtos. A lista prioriza validades pendentes e datas mais próximas; **Exportar validades** baixa o estoque com validade em CSV.
- Cada produto tem uma validade. Ela vale até o fim do dia no fuso configurado em `PDV_TIMEZONE`. A partir do dia seguinte o servidor bloqueia inclusões, aumentos de quantidade, novos pagamentos, confirmação de PIX e fechamento. Alimentos e bebidas antigos sem validade também ficam bloqueados. Remoções e estornos continuam disponíveis. O sistema verifica novamente no servidor em cada operação e atualiza as telas abertas a cada minuto e ao voltar à janela.
- Separe fisicamente os produtos e use **Registrar perda por validade** na linha do produto. Informe a quantidade e o motivo. A baixa atualiza o estoque e seu custo e registra operador, data e motivo nas movimentações e na auditoria. Unidades reservadas precisam ser removidas das comandas antes da baixa. Reenvios da mesma operação não repetem a perda. Operadores sem permissão de estoque precisam de aprovação administrativa.
- Alterar uma validade com estoque exige motivo e fica na auditoria; reservas abertas impedem essa alteração. Entradas manuais e compras não aceitam produtos vencidos ou sem validade obrigatória. Uma devolução pode recolocar um produto vencido no estoque físico, mas ele permanece bloqueado para venda e deve ser separado para perda. Com uma validade por produto, mantenha cadastros separados quando houver datas diferentes simultaneamente.
- **Desmembrar** também verifica a validade: origem e destino devem estar próprios para venda e ter a mesma data. Isso impede transformar estoque vencido em unidades vendáveis ou prolongar sua validade durante a conversão.

### Assistente de estoque local

- Abra **Assistente de estoque**, no menu, ou **Ver análise e dicas**, na Visão geral. O monitor usa análise estatística e regras explicáveis executadas no servidor da loja. Funciona sem internet, chave de API ou envio de dados a serviços externos. Não usa um modelo generativo externo.
- O assistente compara as vendas líquidas dos últimos 30 dias com os 30 anteriores e detecta produtos parados, queda nas vendas, cobertura alta, saldo inativo e riscos de validade. O limite padrão para estoque parado é de 30 dias, ajustável entre 7 e 365 dias. Os dados são atuais e independem do período financeiro selecionado no dashboard; as telas abertas são atualizadas após alterações e a cada minuto.
- Cada dica mostra os números que a justificam. As sugestões incluem exposição, redução de compras e combos com outro produto da mesma categoria cuja saída recente seja comprovada. Um preço de teste só é sugerido quando há custo cadastrado e margem bruta positiva, com desconto limitado a 10% do preço e à metade da margem unitária. Confira taxas, impostos e despesas antes de aplicar qualquer oferta. O assistente não altera preços nem lança movimentos automaticamente.
- Comandas abertas, canceladas e estornadas não contam como vendas concluídas. As devoluções descontam as quantidades das vendas originais. Estoque reservado não entra nas unidades livres nem no custo do saldo parado. O tempo sem saída começa na última venda líquida ou no início do saldo positivo atual, o que for mais recente; zerar e repor o estoque reinicia esse ciclo. Sem movimentação de entrada registrada, o assistente informa que não pode confirmar a idade do saldo.
- A cobertura é uma estimativa baseada no ritmo médio de 30 dias, sem ajuste de sazonalidade. Produtos novos, bases pequenas e custos ausentes são sinalizados. Produtos vencidos ou sem validade obrigatória recebem instruções de separação ou regularização, sem sugestões promocionais. Use a busca, os filtros e **Exportar análise** para revisar os produtos. O acesso exige a permissão **Acessar dashboard e relatórios**.

### Movimentações e relatórios

- Em **Compras e fornecedores**, cadastre o fornecedor e registre o produto, a quantidade e o custo unitário. Em **Produtos**, use **Conferência física** para registrar a contagem e **Desmembrar** para transformar uma embalagem em unidades avulsas. O valor total de estoque transferido é preservado em centavos. Cada variação TCG tem seu próprio código e saldo. Marque a estrela no catálogo do atendimento para adicionar aos favoritos.
- Em **Produtos → Importar CSV**, escolha se deseja criar, atualizar ou ambos. Confira a prévia e os erros antes de aplicar. O estoque da planilha representa a contagem física final. A importação completa é interrompida se houver um erro ou se o estoque mudar depois da prévia.
- Use os filtros de **Visão geral** para selecionar o período. **Conferência gerencial** separa recebimentos, caixa, créditos, devoluções e vendas. As seções expansíveis mostram os registros de cada grupo. A sugestão de reposição usa o maior valor entre o estoque mínimo e as unidades vendidas na janela selecionada e desconta o estoque disponível. Os relatórios históricos preservam o total original da venda e informam as devoluções separadamente.

Exemplo de arquivo de importação, com valores em reais.

Para alimentação e bebidas, inclua a coluna `validade` com uma data no formato `AAAA-MM-DD` (por exemplo, `2027-06-30`). Nas atualizações, omitir essa coluna preserva a validade cadastrada; uma data vazia não é aceita nessas categorias.

```csv
codigo;nome;categoria;preco;estoque;minimo;custo
BOOSTER-01;Booster;TCG;19,90;24;4;12,50
```

### Revisão financeira

- O operador entra em **Atendimento**. O atalho `/#leitor` continua abrindo a leitura no celular. Cancelamentos pertencem ao turno ativo do operador e continuam no histórico após novo login no mesmo turno.
- Recargas, estornos de recarga, entradas de mercadoria, compras de cartas, movimentos de caixa, ajustes manuais de estoque e desmembramentos recebem uma chave por intenção. Se a resposta sumir, repita os mesmos campos na mesma aba. O navegador recupera a chave pendente. O servidor devolve o resultado gravado e rejeita a mesma chave com conteúdo diferente. Uma nova operação após uma resposta confirmada recebe outra chave.
- Em **Compras e fornecedores → Ver compra**, use **Corrigir compra** para lançar os dados substitutos ou **Estornar compra** para desfazer a entrada. O PDV verifica saldo, custo e estoque livre e trata a compra e o crédito na mesma transação. Se houver um estorno de crédito legado, a correção usa esse lançamento existente. Na ficha do cliente, **Total gasto líquido** detalha compras e devoluções.
- O lucro bruto atualizado usa o valor total efetivamente baixado do estoque. Devoluções com reposição recuperam a parcela exata do custo. A última unidade carrega o resíduo de centavos. Sem reposição, o custo permanece no resultado. As vendas históricas sem movimentações suficientes aparecem com custo indisponível.
- **Vendas brutas do período** usa o valor original após descontos, antes de devoluções. **Devoluções pela data da ocorrência** usa o dia e o turno da devolução. **Líquido atualizado das vendas originais** usa o período de encerramento original e desconta as devoluções registradas até a consulta.
- **Histórico**, **Visão geral** e **Conferência gerencial** filtram por produto, caixa e turno. O filtro de produto seleciona vendas inteiras que contenham o item. Para devoluções, considera os itens devolvidos. As listas financeiras da conferência mostram até 100 registros por página. O CSV contempla todo o período filtrado.

A migração SQLite 3 cria o registro das chaves e das correções de compras, acrescenta os custos exatos às baixas e devoluções, vincula cancelamentos a turnos comprovados e adiciona índices dos relatórios. As consultas e a preparação de CSVs rodam em dois workers com conexões SQLite de leitura. Em instalações que usam banco em memória, os relatórios usam a conexão local.

A migração SQLite 4 acrescenta a validade ao cadastro de produtos e preserva os registros existentes. O servidor cria um backup antes de migrar um banco em arquivo.

### Backup, migração e restauração

As migrações versionadas de SQLite fazem cópia consistente antes de alterar um banco existente. Os recebimentos históricos preservam a origem e a data conhecidas. Turnos anteriores à atualização aparecem como legado, sem atribuição inventada.

O backup local automático roda a cada 60 minutos por padrão. **Backups** mostra a última cópia verificada, o destino externo e falhas. Personalize com `PDV_BACKUP_MINUTES` e `PDV_BACKUP_DIR`. Use `0` para desligar o agendamento. Para copiar para outro equipamento, monte o volume de rede e defina `PDV_BACKUP_EXTERNAL_DIR` com o caminho existente nesse Mac. O PDV sinaliza falha se o destino configurado estiver indisponível.

Para testar uma restauração em um arquivo separado, rode:

```sh
npm run restaurar -- data/backups/ARQUIVO.sqlite data/recuperacao/restaurado.sqlite
PDV_DB=data/recuperacao/restaurado.sqlite PDV_PORT=3010 PDV_BACKUP_MINUTES=0 npm start
```

Confira o banco restaurado em `http://localhost:3010`. A restauração exige um caminho novo e verifica a integridade antes e depois da cópia. Para voltar a usar a cópia, encerre a instância operacional e inicie-a com `PDV_DB` apontando para o arquivo recuperado.

## Validação

```sh
npm test
```

Para validar o atendimento responsivo em um navegador Chromium instalado (Chrome ou Edge), execute também:

```sh
npm run test:mobile
```

Esse teste usa banco em memória, contas fictícias e um perfil separado do navegador. Verifica inclusão e edição de produtos, troca de comandas, busca, sincronização com o caixa, queda e recuperação de conexão e 12 resoluções entre 320 e 1366 px. Salva capturas e o resultado em `test-output/mobile/`. Para outro caminho de navegador, defina `PDV_TEST_BROWSER` com o executável. A emulação não substitui a conferência da câmera e do teclado nos aparelhos reais.

Os testes usam instâncias e bancos separados dos dados reais. A suíte gera e decodifica os QR Codes e verifica pareamento, sincronização por eventos, reservas e permissões. Também cobre pagamentos parciais e mistos, PIX, troco, concorrência de crédito, transferência com pagamentos, devoluções, turnos, relatórios, importação CSV, desmembramento e recuperação a partir do backup.

O teste de carga cria 20 mil vendas e mil produtos em um banco temporário. Dispara seis consultas concorrentes de histórico, dashboard, conferência, assistente de estoque e exportações CSV enquanto manda uma leitura pelo leitor pareado. A medição começa no envio do código já reconhecido e termina após a consulta da comanda no caixa.

Para homologar no balcão, teste a aceitação do certificado, enquadramento, leitura de dois cartões em sequência sem reativar a câmera, som, vibração, lanterna, impressão e tempo entre a leitura e a abertura no monitor com o aparelho e a rede que serão usados.
