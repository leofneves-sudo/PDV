# Balcão PDV

PDV local para loja física, com atendimento touchscreen, cartões QR reutilizáveis e leitura contínua pelo celular. A instalação começa com o banco vazio. Os cadastros e as vendas são gravados em SQLite.

## Instalar e iniciar

No computador que vai hospedar o PDV, instale o Node.js 24 ou mais recente. Abra o terminal na pasta do projeto.

```sh
npm ci
npm start
```

1. Abra `http://localhost:3000` no computador do servidor. Crie o primeiro administrador com uma senha de pelo menos dez caracteres. A criação inicial só está disponível no próprio servidor, usando localhost.
2. Em **Operadores**, crie uma conta individual para cada funcionário. O perfil Operador recebe as permissões de atendimento, pagamento, consulta e cadastro de clientes e histórico do próprio turno. Ajuste as permissões por ação antes de entregar os acessos. Conceda a consulta do extrato de créditos aos operadores que precisarem conferir os lançamentos.
3. Cadastre os produtos com o preço, a categoria e o estoque inicial. Use **Movimentar estoque** para entradas e saídas posteriores.
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

Com o PDV já aberto no Mac em `http://localhost:3000`, deixe o servidor rodando e abra um segundo terminal na pasta do projeto.

```sh
npm run celular -- IP_DO_MAC
```

Use o IP mostrado nos ajustes de Wi‑Fi do Mac. O comando imprime o endereço HTTPS na porta `3443` e encaminha as leituras para o mesmo servidor usado pelo caixa. Mantenha os dois terminais abertos.

Transfira `data/https/balcao-ca.cer` do Mac para o celular. Esse é o certificado público da autoridade local do PDV. Os arquivos `.key` ficam no Mac.

- **iPhone** — Abra o arquivo recebido por AirDrop e instale o perfil em **Ajustes**. Depois ative a confiança em **Ajustes → Geral → Sobre → Ajustes de Confiança de Certificado**. [Suporte da Apple](https://support.apple.com/pt-br/102390)
- **Android** — Abra **Instalar certificado** nos ajustes de segurança, escolha **Certificado CA** e selecione o arquivo recebido. Os nomes dos menus variam conforme o aparelho.

No celular, abra o endereço HTTPS exibido no terminal e faça login. No Mac, gere um código em **Parear caixa**. No celular, abra **Leitor de QR → Parear com caixa** e informe o código.

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

- Para operar pelo celular, selecione **Neste dispositivo** e leia o cartão. Se houver atendimento aberto, ele aparece imediatamente. Para um cartão livre, toque em **Iniciar atendimento**. A câmera continua ativa durante o atendimento até ser desligada ou até você sair das telas de atendimento e leitura.
- Para parear, abra **Parear caixa** no computador que vai receber as leituras. Informe o nome do caixa e gere um código. No celular, abra **Leitor de QR**, toque em **Parear com caixa** e informe os seis dígitos em até dois minutos. Cada código dá direito a um vínculo. Mantenha o caixa online. A leitura abre o cartão no caixa vinculado. Use sessões distintas no caixa e no celular.
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

### Estoque e relatórios

- Em **Compras e fornecedores**, cadastre o fornecedor e registre o produto, a quantidade e o custo unitário. Em **Produtos**, use **Conferência física** para registrar a contagem e **Desmembrar** para transformar uma embalagem em unidades avulsas. O valor total de estoque transferido é preservado em centavos. Cada variação TCG tem seu próprio código e saldo. Marque a estrela no catálogo do atendimento para adicionar aos favoritos.
- Em **Produtos → Importar CSV**, escolha se deseja criar, atualizar ou ambos. Confira a prévia e os erros antes de aplicar. O estoque da planilha representa a contagem física final. A importação completa é interrompida se houver um erro ou se o estoque mudar depois da prévia.
- Use os filtros de **Visão geral** para selecionar o período. **Conferência gerencial** separa recebimentos, caixa, créditos, devoluções e vendas. As seções expansíveis mostram os registros de cada grupo. A sugestão de reposição usa o maior valor entre o estoque mínimo e as unidades vendidas na janela selecionada e desconta o estoque disponível. Os relatórios históricos preservam o total original da venda e informam as devoluções separadamente.

Exemplo de arquivo de importação, com valores em reais.

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

Os testes usam instâncias e bancos separados dos dados reais. A suíte gera e decodifica os QR Codes e verifica pareamento, sincronização por eventos, reservas e permissões. Também cobre pagamentos parciais e mistos, PIX, troco, concorrência de crédito, transferência com pagamentos, devoluções, turnos, relatórios, importação CSV, desmembramento e recuperação a partir do backup.

O teste de carga cria 20 mil vendas e mil produtos em um banco temporário. Dispara consultas de histórico, dashboard, conferência e exportação CSV enquanto manda uma leitura pelo leitor pareado. A medição começa no envio do código já reconhecido e termina após a consulta da comanda no caixa.

Para homologar no balcão, teste a aceitação do certificado, enquadramento, leitura de dois cartões em sequência sem reativar a câmera, som, vibração, lanterna, impressão e tempo entre a leitura e a abertura no monitor com o aparelho e a rede que serão usados.
