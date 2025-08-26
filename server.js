require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { calcularPrecoPrazo } = require('correios-brasil');

const app = express();
app.use(bodyParser.json());

// === CONFIGURAÇÕES DO CONTRATO DOS CORREIOS ===
const contract = {
    nCdEmpresa: process.env.CORREIOS_COD_EMPRESA,
    sDsSenha: process.env.CORREIOS_SENHA,
    nCdServico: process.env.CORREIOS_SERVICOS.split(',')
};

// === CENTROS DE DISTRIBUIÇÃO ===
const warehouses = [
    { name: 'CD São Paulo', cep: '01001-000' },
    { name: 'CD Belo Horizonte', cep: '30130-010' }
];

// === FUNÇÃO: obter coordenadas de um CEP ===
async function getCoordinates(cep) {
    const viaCep = await axios.get(`https://viacep.com.br/ws/${cep.replace(/\D/g, '')}/json/`);
    const query = `${viaCep.data.logradouro || ''}, ${viaCep.data.localidade}, ${viaCep.data.uf}`;
    const geo = await axios.get(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
    return {
        lat: parseFloat(geo.data[0]?.lat || 0),
        lon: parseFloat(geo.data[0]?.lon || 0)
    };
}

// === FUNÇÃO: calcular distância entre dois pontos geográficos ===
function calculateDistance(c1, c2) {
    const toRad = deg => deg * Math.PI / 180;
    const R = 6371;
    const dLat = toRad(c2.lat - c1.lat);
    const dLon = toRad(c2.lon - c1.lon);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(c1.lat)) * Math.cos(toRad(c2.lat)) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// === FUNÇÃO: consolidar medidas dos SKUs ===
function consolidateSkus(skus) {
    let totalWeight = 0;
    let totalPrice = 0;
    let volume = 0;

    let maxLength = 0;
    let maxWidth = 0;
    let maxHeight = 0;

    for (const sku of skus) {
        const q = sku.quantity || 1;
        totalWeight += (sku.weight || 1) * q;
        totalPrice += (sku.price || 0) * q;

        // Soma de volumes cúbicos
        volume += (sku.length || 1) * (sku.width || 1) * (sku.height || 1) * q;

        // Para garantir medidas mínimas
        maxLength = Math.max(maxLength, sku.length || 1);
        maxWidth = Math.max(maxWidth, sku.width || 1);
        maxHeight = Math.max(maxHeight, sku.height || 1);
    }

    // Aproxima medidas cúbicas de forma simples
    const cubeRoot = Math.cbrt(volume);
    const medida = Math.max(cubeRoot, 16); // mínimo exigido

    return {
        peso: totalWeight.toFixed(2),
        valorDeclarado: totalPrice.toFixed(2),
        comprimento: Math.max(maxLength, medida, 16),
        largura: Math.max(maxWidth, medida, 11),
        altura: Math.max(maxHeight, medida, 2)
    };
}

// === ENDPOINT PRINCIPAL ===
app.post('/cotacao', async (req, res) => {
    const { zipcode, skus } = req.body;

    try {
        const destinoCoord = await getCoordinates(zipcode);

        // Identificar o CD mais próximo
        let cdMaisProximo = null;
        let menorDistancia = Infinity;

        for (const cd of warehouses) {
            const coordCD = await getCoordinates(cd.cep);
            const distancia = calculateDistance(destinoCoord, coordCD);
            if (distancia < menorDistancia) {
                menorDistancia = distancia;
                cdMaisProximo = cd;
            }
        }

        // Consolidar os SKUs
        const dimensoes = consolidateSkus(skus);

        // Montar payload
        const args = {
            ...contract,
            sCepOrigem: cdMaisProximo.cep.replace(/\D/g, ''),
            sCepDestino: zipcode.replace(/\D/g, ''),
            nVlPeso: dimensoes.peso,
            nCdFormato: '1',
            nVlComprimento: dimensoes.comprimento,
            nVlAltura: dimensoes.altura,
            nVlLargura: dimensoes.largura,
            nVlDiametro: 0,
            nVlValorDeclarado: dimensoes.valorDeclarado,
            sCdMaoPropria: 'N',
            sCdAvisoRecebimento: 'N',
        };

        const resultado = await calcularPrecoPrazo(args);

        const quotes = resultado.map((item, index) => ({
            name: `OPÇÃO FRETE ${index + 1}`,
            service: item.Codigo === '04162' ? 'SEDEX' : 'PAC',
            price: parseFloat(item.Valor.replace(',', '.')),
            days: parseInt(item.PrazoEntrega),
            quote_id: index + 1
        }));

        return res.json({ quotes });
    } catch (error) {
        console.error('Erro:', error.message);
        return res.status(500).json({ error: 'Erro ao calcular cotação de frete.' });
    }
});

// === INICIAR SERVIDOR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚛 API de Frete rodando na porta ${PORT}`);
});